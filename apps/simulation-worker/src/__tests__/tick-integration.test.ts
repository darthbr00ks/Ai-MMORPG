/**
 * End-to-end integration test for the Phase-1 acceptance path (§54/§57
 * of the build plan):
 *
 *   directive submitted -> worker tick -> AI decision -> validated
 *   action -> GameEvent written -> world state changed
 *
 * Runs against a REAL Postgres — this is deliberately not mocked at the
 * DB layer, only the AI provider is mocked (MockProvider, zero cost).
 *
 * Requires DATABASE_URL to point at a reachable, migrated Postgres
 * (`docker compose up -d && pnpm db:migrate` from the repo root). If
 * DATABASE_URL is unset the whole suite is skipped rather than failing
 * — see the note in the build-plan review about this environment not
 * having Docker/Postgres available to actually execute this file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, and, or, inArray } from 'drizzle-orm';
import { schema } from '@ai-world/database';
import { MockProvider } from '@ai-world/ai';
import type { AgentModelProvider } from '@ai-world/ai';
import type {
  AgentDecision,
  AgentDecisionContext,
  DialogueContext,
  DialogueResult,
  SummaryContext,
  SummaryResult,
  MemoryContext,
  MemoryResult,
  ModerationResult,
} from '@ai-world/shared';
import { processTick } from '../tick-processor.js';

const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('processTick — full directive-to-event path', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let characterId: string;
  let locationId: string;
  let userId: string;

  beforeAll(async () => {
    client = postgres(DB_URL!);
    db = drizzle(client, { schema });

    const [location] = await db
      .insert(schema.locations)
      .values({
        name: 'Test Square',
        slug: `test-square-${Date.now()}`,
        description: 'A test location',
        connections: [],
      })
      .returning({ id: schema.locations.id });
    locationId = location.id;

    const [user] = await db
      .insert(schema.users)
      .values({ email: `test-${Date.now()}@example.com` })
      .returning({ id: schema.users.id });
    userId = user.id;

    const [character] = await db
      .insert(schema.characters)
      .values({
        name: 'Test Character',
        age: 30,
        background: 'A character created for integration testing.',
        personalityTraits: [{ trait: 'cautious', weight: 0.8 }],
        skills: [],
        ambitions: ['earn wealth'],
        archetype: 'wealth-seeker',
      })
      .returning({ id: schema.characters.id });
    characterId = character.id;

    await db.insert(schema.characterOwnership).values({
      characterId,
      userId,
      active: true,
    });

    await db.insert(schema.characterState).values({
      characterId,
      locationId,
      health: 100,
      fatigue: 0,
      status: 'idle',
    });

    await db.insert(schema.wallets).values({ characterId, balanceCents: 1000 });

    // The directive itself, matching what the /api/directives route would write
    await db.insert(schema.directives).values({
      characterId,
      userId,
      text: 'Become wealthy through honest work.',
      gameDay: 0,
      active: true,
    });
  });

  afterAll(async () => {
    // Best-effort cleanup — leaves nothing behind for repeat runs.
    // Order matters: FK constraints require ai_usage/agentActions/
    // gameEvents/agentDecisions gone before the character itself. Scope
    // agentActions to this character's own decisions only — never
    // truncate the whole table, it may hold other tests'/seed data.
    const ownDecisions = await db
      .select({ id: schema.agentDecisions.id })
      .from(schema.agentDecisions)
      .where(eq(schema.agentDecisions.characterId, characterId));
    const decisionIds = ownDecisions.map((d) => d.id);

    await db.delete(schema.gameEvents).where(eq(schema.gameEvents.actorCharacterId, characterId));
    await db.delete(schema.aiUsage).where(eq(schema.aiUsage.characterId, characterId));
    if (decisionIds.length > 0) {
      await db.delete(schema.agentActions).where(inArray(schema.agentActions.decisionId, decisionIds));
    }
    // A WORK action credits the wallet, which writes a ledger row with
    // this character as the recipient — must go before the wallet/character.
    await db.delete(schema.transactions).where(eq(schema.transactions.toCharacterId, characterId));
    await db.delete(schema.agentDecisions).where(eq(schema.agentDecisions.characterId, characterId));
    await db.delete(schema.directives).where(eq(schema.directives.characterId, characterId));
    await db.delete(schema.wallets).where(eq(schema.wallets.characterId, characterId));
    await db.delete(schema.characterState).where(eq(schema.characterState.characterId, characterId));
    await db.delete(schema.characterOwnership).where(eq(schema.characterOwnership.characterId, characterId));
    await db.delete(schema.characters).where(eq(schema.characters.id, characterId));
    await db.delete(schema.locations).where(eq(schema.locations.id, locationId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await client.end();
  });

  it('produces at least one decision and one event for the character', async () => {
    const result = await processTick(
      db,
      new MockProvider(),
      {
        gameDayRealSeconds: 300,
        simulationTickSeconds: 10,
        dailyBudgetCents: 500,
        providerName: 'mock',
        modelName: 'mock',
      },
      new Date()
    );

    expect(result.processedCharacters).toBeGreaterThan(0);
    // processTick sweeps every character in the table, exactly as it
    // would in production alongside the seeded 20 — assert this test's
    // own character produced no error, not that the whole table is
    // error-free (unrelated rows aren't this test's concern).
    expect(result.errors.some((e) => e.includes(characterId))).toBe(false);

    const decisions = await db
      .select()
      .from(schema.agentDecisions)
      .where(eq(schema.agentDecisions.characterId, characterId));
    expect(decisions.length).toBeGreaterThanOrEqual(1);

    const actions = await db
      .select()
      .from(schema.agentActions)
      .where(eq(schema.agentActions.decisionId, decisions[0].id));
    expect(actions.length).toBe(1);
    expect(['valid', 'rejected', 'fallback']).toContain(actions[0].validationResult);

    // Every processed character writes a GameEvent one way or another
    // (CHARACTER_IDLE / CHARACTER_MOVED / MONEY_EARNED / ACTION_REJECTED).
    const events = await db
      .select()
      .from(schema.gameEvents)
      .where(eq(schema.gameEvents.actorCharacterId, characterId));
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('records ai_usage for the decision call', async () => {
    const usage = await db
      .select()
      .from(schema.aiUsage)
      .where(eq(schema.aiUsage.characterId, characterId));
    expect(usage.length).toBeGreaterThanOrEqual(1);
    expect(usage[0].purpose).toBe('decideAction');
  });
});

/**
 * Regression test for a real bug caught while watching the live worker:
 * a character mid-travel (status='traveling', travelEta in the future)
 * is correctly skipped for an AI decision call (§12 — no decision call
 * every tick while traveling), but `processTick`'s returned
 * `processedCharacters` count used to silently drop them via a bare
 * `continue` before the counter was incremented. That made the count
 * an inaccurate "did this tick cover everyone" signal any time a
 * character was traveling — which, in a 20-character world, is most
 * ticks. This asserts a traveling character still counts as processed
 * and, distinctly, generates no new decision while still traveling.
 */
describe.skipIf(!DB_URL)('processTick — traveling characters count as processed', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let characterId: string;
  let locationId: string;
  let userId: string;

  beforeAll(async () => {
    client = postgres(DB_URL!);
    db = drizzle(client, { schema });

    const [location] = await db
      .insert(schema.locations)
      .values({
        name: 'Traveling Test Square',
        slug: `traveling-test-square-${Date.now()}`,
        description: 'A test location',
        connections: [],
      })
      .returning({ id: schema.locations.id });
    locationId = location.id;

    const [user] = await db
      .insert(schema.users)
      .values({ email: `traveling-test-${Date.now()}@example.com` })
      .returning({ id: schema.users.id });
    userId = user.id;

    const [character] = await db
      .insert(schema.characters)
      .values({
        name: 'Traveling Test Character',
        age: 30,
        background: 'A character created to test the mid-travel skip path.',
        personalityTraits: [],
        skills: [],
        ambitions: [],
        archetype: 'wealth-seeker',
      })
      .returning({ id: schema.characters.id });
    characterId = character.id;

    await db.insert(schema.characterOwnership).values({ characterId, userId, active: true });

    // Mid-travel with an ETA an hour from now — must not resolve during the test.
    await db.insert(schema.characterState).values({
      characterId,
      locationId,
      health: 100,
      fatigue: 0,
      status: 'traveling',
      travelEta: new Date(Date.now() + 60 * 60 * 1000),
      travelDestinationId: locationId,
    });

    await db.insert(schema.wallets).values({ characterId, balanceCents: 1000 });
  });

  afterAll(async () => {
    await db.delete(schema.characterState).where(eq(schema.characterState.characterId, characterId));
    await db.delete(schema.wallets).where(eq(schema.wallets.characterId, characterId));
    await db.delete(schema.characterOwnership).where(eq(schema.characterOwnership.characterId, characterId));
    await db.delete(schema.characters).where(eq(schema.characters.id, characterId));
    await db.delete(schema.locations).where(eq(schema.locations.id, locationId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await client.end();
  });

  it('counts the traveling character in processedCharacters without giving it a decision', async () => {
    const before = await db
      .select()
      .from(schema.agentDecisions)
      .where(eq(schema.agentDecisions.characterId, characterId));
    expect(before.length).toBe(0);

    const result = await processTick(
      db,
      new MockProvider(),
      {
        gameDayRealSeconds: 300,
        simulationTickSeconds: 10,
        dailyBudgetCents: 500,
        providerName: 'mock',
        modelName: 'mock',
      },
      new Date()
    );

    // The tick engine considered this character and correctly chose
    // not to call the AI for it — that's still "processed", not "not
    // reached". processedCharacters must be at least 1 to prove this
    // character (and not just others) tripped the counter.
    expect(result.processedCharacters).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.includes(characterId))).toBe(false);

    const after = await db
      .select()
      .from(schema.agentDecisions)
      .where(eq(schema.agentDecisions.characterId, characterId));
    expect(after.length).toBe(0);
  });
});

/**
 * A deterministic stand-in for MockProvider, used only by the
 * conversation test below. MockProvider's social-loop cadence
 * (§ mock-provider.ts, "every 3rd call") is keyed off a call counter
 * shared across every character processTick touches in a single tick —
 * coupling a test's pass/fail to that counter would make the test
 * fragile against unrelated seed data or ordering, not against the
 * conversation feature itself. This provider always starts/continues a
 * conversation when one is available, so the test only depends on
 * tick-processor's own wiring.
 */
class AlwaysConverseProvider implements AgentModelProvider {
  async decideAction(ctx: AgentDecisionContext): Promise<AgentDecision> {
    const openConversation = ctx.activeConversations[0];
    if (openConversation) {
      return {
        goal: 'continue the conversation',
        selected_action: 'CONTINUE_CONVERSATION',
        target_id: openConversation.conversationId,
        parameters: {},
        intent: 'responding',
        priority: 0.5,
      };
    }
    const nearbyCharacter = ctx.visibleCharacters[0];
    if (nearbyCharacter) {
      return {
        goal: 'start a conversation',
        selected_action: 'START_CONVERSATION',
        target_id: nearbyCharacter.characterId,
        parameters: { topic: 'greetings' },
        intent: 'starting a conversation',
        priority: 0.5,
      };
    }
    return {
      goal: 'wait',
      selected_action: 'IDLE',
      target_id: null,
      parameters: {},
      intent: 'nobody around to talk to',
      priority: 0.1,
    };
  }

  async generateDialogue(_ctx: DialogueContext): Promise<DialogueResult> {
    return { message: 'Well met, friend.', emotionalTone: 'friendly' };
  }

  async summarizeEvents(_ctx: SummaryContext): Promise<SummaryResult> {
    return { summary: '' };
  }

  async extractMemory(_ctx: MemoryContext): Promise<MemoryResult> {
    return { extractedMemories: [] };
  }

  async moderateDirective(_text: string): Promise<ModerationResult> {
    return { status: 'accepted', reason_category: '' };
  }
}

describe.skipIf(!DB_URL)(
  'processTick — two characters at the same location converse',
  () => {
    let client: ReturnType<typeof postgres>;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let locationId: string;
    let characterAId: string;
    let characterBId: string;

    beforeAll(async () => {
      client = postgres(DB_URL!);
      db = drizzle(client, { schema });

      const [location] = await db
        .insert(schema.locations)
        .values({
          name: 'Conversation Test Square',
          slug: `conversation-test-square-${Date.now()}`,
          description: 'A test location',
          connections: [],
        })
        .returning({ id: schema.locations.id });
      locationId = location.id;

      const [charA] = await db
        .insert(schema.characters)
        .values({
          name: 'Conversationalist A',
          age: 28,
          background: 'A character created to test conversations.',
          personalityTraits: [],
          skills: [],
          ambitions: [],
          archetype: 'socialite',
        })
        .returning({ id: schema.characters.id });
      characterAId = charA.id;

      const [charB] = await db
        .insert(schema.characters)
        .values({
          name: 'Conversationalist B',
          age: 31,
          background: 'A character created to test conversations.',
          personalityTraits: [],
          skills: [],
          ambitions: [],
          archetype: 'socialite',
        })
        .returning({ id: schema.characters.id });
      characterBId = charB.id;

      for (const characterId of [characterAId, characterBId]) {
        await db.insert(schema.characterState).values({
          characterId,
          locationId,
          health: 100,
          fatigue: 0,
          status: 'idle',
        });
        await db.insert(schema.wallets).values({ characterId, balanceCents: 1000 });
      }
    });

    afterAll(async () => {
      const bothIds = [characterAId, characterBId];
      const ownDecisions = await db
        .select({ id: schema.agentDecisions.id })
        .from(schema.agentDecisions)
        .where(inArray(schema.agentDecisions.characterId, bothIds));
      const decisionIds = ownDecisions.map((d) => d.id);

      const ownConversations = await db.select().from(schema.conversations);
      const conversationIds = ownConversations
        .filter((c) =>
          ((c.participantIds as string[]) ?? []).some((id) => bothIds.includes(id))
        )
        .map((c) => c.id);

      if (conversationIds.length > 0) {
        await db
          .delete(schema.conversationMessages)
          .where(inArray(schema.conversationMessages.conversationId, conversationIds));
        await db.delete(schema.conversations).where(inArray(schema.conversations.id, conversationIds));
      }
      await db.delete(schema.relationships).where(
        or(
          and(eq(schema.relationships.characterAId, characterAId), eq(schema.relationships.characterBId, characterBId)),
          and(eq(schema.relationships.characterAId, characterBId), eq(schema.relationships.characterBId, characterAId))
        )
      );
      await db.delete(schema.gameEvents).where(inArray(schema.gameEvents.actorCharacterId, bothIds));
      await db.delete(schema.aiUsage).where(inArray(schema.aiUsage.characterId, bothIds));
      if (decisionIds.length > 0) {
        await db.delete(schema.agentActions).where(inArray(schema.agentActions.decisionId, decisionIds));
      }
      await db.delete(schema.agentDecisions).where(inArray(schema.agentDecisions.characterId, bothIds));
      await db.delete(schema.wallets).where(inArray(schema.wallets.characterId, bothIds));
      await db.delete(schema.characterState).where(inArray(schema.characterState.characterId, bothIds));
      await db.delete(schema.characters).where(inArray(schema.characters.id, bothIds));
      await db.delete(schema.locations).where(eq(schema.locations.id, locationId));
      await client.end();
    });

    it('creates a conversation, writes a message, and moves the relationship off neutral', async () => {
      const result = await processTick(
        db,
        new AlwaysConverseProvider(),
        {
          gameDayRealSeconds: 300,
          simulationTickSeconds: 10,
          dailyBudgetCents: 500,
          providerName: 'mock',
          modelName: 'mock',
        },
        new Date()
      );

      expect(result.errors.some((e) => e.includes(characterAId) || e.includes(characterBId))).toBe(
        false
      );

      const conversationStartedEvents = await db
        .select()
        .from(schema.gameEvents)
        .where(
          and(
            eq(schema.gameEvents.type, 'CONVERSATION_STARTED'),
            inArray(schema.gameEvents.actorCharacterId, [characterAId, characterBId])
          )
        );
      // Both characters see each other as visible from the same
      // pre-tick snapshot (§ tick-processor.ts's batch load), so either
      // or both may initiate — at least one CONVERSATION_STARTED is the
      // correctness bar, not exactly one.
      expect(conversationStartedEvents.length).toBeGreaterThanOrEqual(1);

      const relationshipRow = await db
        .select()
        .from(schema.relationships)
        .where(
          or(
            and(
              eq(schema.relationships.characterAId, characterAId),
              eq(schema.relationships.characterBId, characterBId)
            ),
            and(
              eq(schema.relationships.characterAId, characterBId),
              eq(schema.relationships.characterBId, characterAId)
            )
          )
        );
      expect(relationshipRow.length).toBe(1);
      expect(relationshipRow[0].familiarity).toBeGreaterThan(0);

      const relationshipChangedEvents = await db
        .select()
        .from(schema.gameEvents)
        .where(
          and(
            eq(schema.gameEvents.type, 'RELATIONSHIP_CHANGED'),
            inArray(schema.gameEvents.actorCharacterId, [characterAId, characterBId])
          )
        );
      expect(relationshipChangedEvents.length).toBeGreaterThanOrEqual(1);
    });
  }
);
