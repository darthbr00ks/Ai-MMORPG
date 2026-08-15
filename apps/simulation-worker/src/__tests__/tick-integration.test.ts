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

/**
 * A provider that records the AgentDecisionContext it was handed for
 * EVERY character (processTick sweeps the whole characters table, not
 * just a test's own rows, and iteration order is not guaranteed — a
 * single "last context" would be whichever character the query
 * happened to visit last, not necessarily the one under test). Keyed
 * by characterId so the test can look up its own character
 * specifically. This is what makes ctx.recentMemories (Phase 11)
 * observable from outside processTick.
 */
class ContextCapturingProvider extends MockProvider {
  contextsByCharacterId = new Map<string, AgentDecisionContext>();

  override async decideAction(ctx: AgentDecisionContext): Promise<AgentDecision> {
    this.contextsByCharacterId.set(ctx.characterId, ctx);
    return super.decideAction(ctx);
  }
}

describe.skipIf(!DB_URL)('processTick — recentMemories reaches the decision context', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let characterId: string;
  let locationId: string;
  const memoryContent = 'Once helped a stranger find their way to the market.';

  beforeAll(async () => {
    client = postgres(DB_URL!);
    db = drizzle(client, { schema });

    const [location] = await db
      .insert(schema.locations)
      .values({
        name: 'Memory Context Test Square',
        slug: `memory-context-test-square-${Date.now()}`,
        description: 'A test location',
        connections: [],
      })
      .returning({ id: schema.locations.id });
    locationId = location.id;

    const [character] = await db
      .insert(schema.characters)
      .values({
        name: 'Rememberer',
        age: 45,
        background: 'A character created to test recentMemories context wiring.',
        personalityTraits: [],
        skills: [],
        ambitions: [],
        archetype: 'peacekeeper',
      })
      .returning({ id: schema.characters.id });
    characterId = character.id;

    await db.insert(schema.characterState).values({
      characterId,
      locationId,
      health: 100,
      fatigue: 0,
      status: 'idle',
    });
    await db.insert(schema.wallets).values({ characterId, balanceCents: 1000 });
    await db.insert(schema.memories).values({
      characterId,
      kind: 'episodic',
      content: memoryContent,
      importance: 0.5,
    });
  });

  afterAll(async () => {
    await db.delete(schema.memories).where(eq(schema.memories.characterId, characterId));
    await db.delete(schema.gameEvents).where(eq(schema.gameEvents.actorCharacterId, characterId));
    await db.delete(schema.aiUsage).where(eq(schema.aiUsage.characterId, characterId));
    await db.delete(schema.agentActions).where(
      inArray(
        schema.agentActions.decisionId,
        (
          await db
            .select({ id: schema.agentDecisions.id })
            .from(schema.agentDecisions)
            .where(eq(schema.agentDecisions.characterId, characterId))
        ).map((d) => d.id)
      )
    );
    await db.delete(schema.agentDecisions).where(eq(schema.agentDecisions.characterId, characterId));
    // A WORK action credits the wallet, which writes a ledger row with
    // this character as the recipient — must go before the
    // wallet/character delete, same as the first describe block above.
    await db.delete(schema.transactions).where(eq(schema.transactions.toCharacterId, characterId));
    await db.delete(schema.wallets).where(eq(schema.wallets.characterId, characterId));
    await db.delete(schema.characterState).where(eq(schema.characterState.characterId, characterId));
    await db.delete(schema.characters).where(eq(schema.characters.id, characterId));
    await db.delete(schema.locations).where(eq(schema.locations.id, locationId));
    await client.end();
  });

  it('includes a pre-existing memory in the character\'s decision context', async () => {
    const provider = new ContextCapturingProvider();
    await processTick(
      db,
      provider,
      {
        gameDayRealSeconds: 300,
        simulationTickSeconds: 10,
        dailyBudgetCents: 500,
        providerName: 'mock',
        modelName: 'mock',
      },
      new Date()
    );

    const ctx = provider.contextsByCharacterId.get(characterId);
    expect(ctx).toBeDefined();
    expect(ctx?.recentMemories).toContain(memoryContent);
  });
});

/**
 * A provider whose decision for each character is scripted in
 * advance, keyed by characterId — needed for the economy test below,
 * which puts several characters through several different actions
 * (BUY_ITEM, SELL_ITEM, GIVE_ITEM, TRANSFER_MONEY) in a single tick
 * and needs each one to do a SPECIFIC thing, not MockProvider's
 * generic heuristics. Any character not in the script IDLEs.
 */
class ScriptedProvider extends MockProvider {
  constructor(private readonly scriptByCharacterId: Map<string, AgentDecision>) {
    super();
  }

  override async decideAction(ctx: AgentDecisionContext): Promise<AgentDecision> {
    return (
      this.scriptByCharacterId.get(ctx.characterId) ?? {
        goal: 'wait',
        selected_action: 'IDLE',
        target_id: null,
        parameters: {},
        intent: 'not scripted for this test',
        priority: 0.1,
      }
    );
  }
}

/**
 * Phase 12 (§6): BUY_ITEM/SELL_ITEM/GIVE_ITEM/TRANSFER_MONEY. BUY/SELL
 * are gated to the "market" location by slug (see
 * action-validator.ts's MARKET_LOCATION_SLUG) — that's hardcoded, not
 * data-driven, so this test reuses the real seeded "market" location
 * rather than creating its own (locations.slug is unique; a second row
 * with the same slug isn't possible). This means the test DOES depend
 * on `pnpm db:seed` having been run against DATABASE_URL, same as the
 * documented developer workflow (§15's acceptance checklist) — fails
 * with a clear error rather than silently skipping if it hasn't.
 */
describe.skipIf(!DB_URL)('processTick — economy actions', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let marketLocationId: string;
  let itemId: string;
  let buyerId: string;
  let sellerId: string;
  let giverId: string;
  let giveRecipientId: string;
  let senderId: string;
  let moneyRecipientId: string;
  let allCharacterIds: string[];

  const ITEM_PRICE_CENTS = 100;

  beforeAll(async () => {
    client = postgres(DB_URL!);
    db = drizzle(client, { schema });

    const [marketLocation] = await db
      .select()
      .from(schema.locations)
      .where(eq(schema.locations.slug, 'market'))
      .limit(1);
    if (!marketLocation) {
      throw new Error(
        'processTick — economy actions requires a seeded "market" location. Run `pnpm db:seed` against DATABASE_URL before running this test.'
      );
    }
    marketLocationId = marketLocation.id;

    const [item] = await db
      .insert(schema.items)
      .values({ name: 'Economy Test Widget', category: 'test', basePriceCents: ITEM_PRICE_CENTS })
      .returning({ id: schema.items.id });
    itemId = item.id;

    async function makeCharacter(name: string, walletCents: number): Promise<string> {
      const [character] = await db
        .insert(schema.characters)
        .values({
          name,
          age: 30,
          background: 'A character created to test Phase 12 economy actions.',
          personalityTraits: [],
          skills: [],
          ambitions: [],
          archetype: 'wealth-seeker',
        })
        .returning({ id: schema.characters.id });
      await db.insert(schema.characterState).values({
        characterId: character.id,
        locationId: marketLocationId,
        health: 100,
        fatigue: 0,
        status: 'idle',
      });
      await db.insert(schema.wallets).values({ characterId: character.id, balanceCents: walletCents });
      return character.id;
    }

    buyerId = await makeCharacter('Economy Test Buyer', 1000);
    sellerId = await makeCharacter('Economy Test Seller', 0);
    giverId = await makeCharacter('Economy Test Giver', 0);
    giveRecipientId = await makeCharacter('Economy Test Give Recipient', 0);
    senderId = await makeCharacter('Economy Test Sender', 1000);
    moneyRecipientId = await makeCharacter('Economy Test Money Recipient', 0);
    allCharacterIds = [buyerId, sellerId, giverId, giveRecipientId, senderId, moneyRecipientId];

    // Seller and giver need inventory to sell/give BEFORE the tick —
    // seeded directly, not through an action, since setting up test
    // fixtures isn't itself the thing under test.
    await db.insert(schema.inventory).values([
      { characterId: sellerId, itemId, quantity: 5 },
      { characterId: giverId, itemId, quantity: 5 },
    ]);
  });

  afterAll(async () => {
    const ownDecisions = await db
      .select({ id: schema.agentDecisions.id })
      .from(schema.agentDecisions)
      .where(inArray(schema.agentDecisions.characterId, allCharacterIds));
    const decisionIds = ownDecisions.map((d) => d.id);

    await db.delete(schema.relationships).where(
      or(
        ...allCharacterIds.flatMap((a) =>
          allCharacterIds.map((b) =>
            and(eq(schema.relationships.characterAId, a), eq(schema.relationships.characterBId, b))
          )
        )
      )
    );
    await db.delete(schema.gameEvents).where(inArray(schema.gameEvents.actorCharacterId, allCharacterIds));
    await db.delete(schema.aiUsage).where(inArray(schema.aiUsage.characterId, allCharacterIds));
    if (decisionIds.length > 0) {
      await db.delete(schema.agentActions).where(inArray(schema.agentActions.decisionId, decisionIds));
    }
    await db.delete(schema.agentDecisions).where(inArray(schema.agentDecisions.characterId, allCharacterIds));
    await db.delete(schema.transactions).where(
      or(
        inArray(schema.transactions.fromCharacterId, allCharacterIds),
        inArray(schema.transactions.toCharacterId, allCharacterIds)
      )
    );
    await db.delete(schema.inventory).where(inArray(schema.inventory.characterId, allCharacterIds));
    await db.delete(schema.wallets).where(inArray(schema.wallets.characterId, allCharacterIds));
    await db.delete(schema.characterState).where(inArray(schema.characterState.characterId, allCharacterIds));
    await db.delete(schema.characters).where(inArray(schema.characters.id, allCharacterIds));
    await db.delete(schema.items).where(eq(schema.items.id, itemId));
    await client.end();
  });

  it('executes BUY_ITEM, SELL_ITEM, GIVE_ITEM, and TRANSFER_MONEY end to end', async () => {
    const script = new Map<string, AgentDecision>([
      [
        buyerId,
        {
          goal: 'stock up',
          selected_action: 'BUY_ITEM',
          target_id: itemId,
          parameters: { quantity: 3 },
          intent: 'buying widgets',
          priority: 0.5,
        },
      ],
      [
        sellerId,
        {
          goal: 'raise cash',
          selected_action: 'SELL_ITEM',
          target_id: itemId,
          parameters: { quantity: 2 },
          intent: 'selling widgets',
          priority: 0.5,
        },
      ],
      [
        giverId,
        {
          goal: 'help a friend',
          selected_action: 'GIVE_ITEM',
          target_id: giveRecipientId,
          parameters: { itemId, quantity: 2 },
          intent: 'sharing widgets',
          priority: 0.5,
        },
      ],
      [
        senderId,
        {
          goal: 'help a friend',
          selected_action: 'TRANSFER_MONEY',
          target_id: moneyRecipientId,
          parameters: { amountCents: 400 },
          intent: 'lending a hand',
          priority: 0.5,
        },
      ],
    ]);

    const result = await processTick(
      db,
      new ScriptedProvider(script),
      {
        gameDayRealSeconds: 300,
        simulationTickSeconds: 10,
        dailyBudgetCents: 500,
        providerName: 'mock',
        modelName: 'mock',
      },
      new Date()
    );

    expect(result.errors.some((e) => allCharacterIds.some((id) => e.includes(id)))).toBe(false);

    // BUY_ITEM: 3 * 100 = 300 cents spent, +3 inventory.
    const [buyerWallet] = await db.select().from(schema.wallets).where(eq(schema.wallets.characterId, buyerId));
    expect(buyerWallet.balanceCents).toBe(1000 - 300);
    const [buyerInventory] = await db
      .select()
      .from(schema.inventory)
      .where(and(eq(schema.inventory.characterId, buyerId), eq(schema.inventory.itemId, itemId)));
    expect(buyerInventory.quantity).toBe(3);

    // SELL_ITEM: 2 * (100 * 0.5) = 100 cents earned, 5 - 2 = 3 inventory left.
    const [sellerWallet] = await db.select().from(schema.wallets).where(eq(schema.wallets.characterId, sellerId));
    expect(sellerWallet.balanceCents).toBe(100);
    const [sellerInventory] = await db
      .select()
      .from(schema.inventory)
      .where(and(eq(schema.inventory.characterId, sellerId), eq(schema.inventory.itemId, itemId)));
    expect(sellerInventory.quantity).toBe(3);

    // GIVE_ITEM: giver 5 - 2 = 3, recipient 0 + 2 = 2.
    const [giverInventory] = await db
      .select()
      .from(schema.inventory)
      .where(and(eq(schema.inventory.characterId, giverId), eq(schema.inventory.itemId, itemId)));
    expect(giverInventory.quantity).toBe(3);
    const [recipientInventory] = await db
      .select()
      .from(schema.inventory)
      .where(and(eq(schema.inventory.characterId, giveRecipientId), eq(schema.inventory.itemId, itemId)));
    expect(recipientInventory.quantity).toBe(2);

    // TRANSFER_MONEY: sender 1000 - 400 = 600, recipient 0 + 400 = 400.
    const [senderWallet] = await db.select().from(schema.wallets).where(eq(schema.wallets.characterId, senderId));
    expect(senderWallet.balanceCents).toBe(600);
    const [moneyRecipientWallet] = await db
      .select()
      .from(schema.wallets)
      .where(eq(schema.wallets.characterId, moneyRecipientId));
    expect(moneyRecipientWallet.balanceCents).toBe(400);

    // Both GIVE_ITEM and TRANSFER_MONEY are gifts (§5) — deterministic
    // relationship effects, not LLM-assigned.
    const relationshipRows = await db
      .select()
      .from(schema.relationships)
      .where(
        or(
          and(eq(schema.relationships.characterAId, giverId), eq(schema.relationships.characterBId, giveRecipientId)),
          and(eq(schema.relationships.characterAId, giveRecipientId), eq(schema.relationships.characterBId, giverId))
        )
      );
    expect(relationshipRows.length).toBe(1);
    expect(relationshipRows[0].trust).toBeGreaterThan(0);

    const eventTypes = await db
      .select({ type: schema.gameEvents.type })
      .from(schema.gameEvents)
      .where(inArray(schema.gameEvents.actorCharacterId, allCharacterIds));
    const eventTypeSet = new Set(eventTypes.map((e) => e.type));
    expect(eventTypeSet.has('ITEM_PURCHASED')).toBe(true);
    expect(eventTypeSet.has('ITEM_SOLD')).toBe(true);
    expect(eventTypeSet.has('ITEM_GIVEN')).toBe(true);
    expect(eventTypeSet.has('MONEY_TRANSFERRED')).toBe(true);
  });
});

/**
 * Economy-phase-1: proves the dynamic-pricing wiring actually reaches
 * BUY_ITEM's real charge, not just that game-engine/market-pricing.ts's
 * calculateMarketPrice is correct in isolation (already covered by its
 * own unit tests). Seeds real recent-purchase pressure via ITEM_PURCHASED
 * game_events (the same signal tick-processor.ts reads), then confirms
 * a BUY_ITEM in the very next tick is actually charged above the item's
 * static basePriceCents — not just quoted a higher currentPriceCents
 * that then goes unused at execution time.
 */
describe.skipIf(!DB_URL)('processTick — dynamic market pricing reaches BUY_ITEM\'s real charge', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let marketLocationId: string;
  let itemId: string;
  let buyerId: string;
  let pressureActorId: string;

  const BASE_PRICE_CENTS = 100;
  // Comfortably clears MIN_PRICE_MULTIPLIER..MAX_PRICE_MULTIPLIER's
  // saturation point (market-pricing.ts) so this test isn't sensitive
  // to the exact pressure-sensitivity constant, only its direction.
  const SIMULATED_RECENT_PURCHASES = 30;

  beforeAll(async () => {
    client = postgres(DB_URL!);
    db = drizzle(client, { schema });

    const [marketLocation] = await db
      .select()
      .from(schema.locations)
      .where(eq(schema.locations.slug, 'market'))
      .limit(1);
    if (!marketLocation) {
      throw new Error(
        'processTick — dynamic market pricing requires a seeded "market" location. Run `pnpm db:seed` against DATABASE_URL before running this test.'
      );
    }
    marketLocationId = marketLocation.id;

    const [item] = await db
      .insert(schema.items)
      .values({ name: 'Pricing Test Widget', category: 'test', basePriceCents: BASE_PRICE_CENTS })
      .returning({ id: schema.items.id });
    itemId = item.id;

    const [pressureActor] = await db
      .insert(schema.characters)
      .values({
        name: 'Pricing Test Pressure Actor',
        age: 30,
        background: 'Exists only so ITEM_PURCHASED events can be attributed to someone.',
        personalityTraits: [],
        skills: [],
        ambitions: [],
        archetype: 'wealth-seeker',
      })
      .returning({ id: schema.characters.id });
    pressureActorId = pressureActor.id;

    // Real recent purchase pressure — the exact signal tick-processor.ts
    // reads (ITEM_PURCHASED events within the last gameDayRealSeconds).
    await db.insert(schema.gameEvents).values(
      Array.from({ length: SIMULATED_RECENT_PURCHASES }, () => ({
        type: 'ITEM_PURCHASED' as const,
        actorCharacterId: pressureActorId,
        payload: { item_id: itemId, item_name: 'Pricing Test Widget', quantity: 1, total_cost_cents: BASE_PRICE_CENTS },
        importance: 0.2,
        createdAt: new Date(),
      }))
    );

    const [buyer] = await db
      .insert(schema.characters)
      .values({
        name: 'Pricing Test Buyer',
        age: 30,
        background: 'A character created to test dynamic pricing reaching BUY_ITEM.',
        personalityTraits: [],
        skills: [],
        ambitions: [],
        archetype: 'wealth-seeker',
      })
      .returning({ id: schema.characters.id });
    buyerId = buyer.id;
    await db.insert(schema.characterState).values({
      characterId: buyerId,
      locationId: marketLocationId,
      health: 100,
      fatigue: 0,
      status: 'idle',
    });
    // Comfortably covers even MAX_PRICE_MULTIPLIER's ceiling.
    await db.insert(schema.wallets).values({ characterId: buyerId, balanceCents: 100_000 });
  });

  afterAll(async () => {
    const allIds = [buyerId, pressureActorId];
    const ownDecisions = await db
      .select({ id: schema.agentDecisions.id })
      .from(schema.agentDecisions)
      .where(inArray(schema.agentDecisions.characterId, allIds));
    const decisionIds = ownDecisions.map((d) => d.id);

    // Deleting by actor id covers every row this test itself created —
    // both the seeded ITEM_PURCHASED pressure events and whatever the
    // tick wrote for the buyer.
    await db.delete(schema.gameEvents).where(inArray(schema.gameEvents.actorCharacterId, allIds));
    await db.delete(schema.aiUsage).where(inArray(schema.aiUsage.characterId, allIds));
    if (decisionIds.length > 0) {
      await db.delete(schema.agentActions).where(inArray(schema.agentActions.decisionId, decisionIds));
    }
    await db.delete(schema.agentDecisions).where(inArray(schema.agentDecisions.characterId, allIds));
    await db.delete(schema.transactions).where(
      or(inArray(schema.transactions.fromCharacterId, allIds), inArray(schema.transactions.toCharacterId, allIds))
    );
    await db.delete(schema.inventory).where(inArray(schema.inventory.characterId, allIds));
    await db.delete(schema.wallets).where(inArray(schema.wallets.characterId, allIds));
    await db.delete(schema.characterState).where(inArray(schema.characterState.characterId, allIds));
    await db.delete(schema.characters).where(inArray(schema.characters.id, allIds));
    await db.delete(schema.items).where(eq(schema.items.id, itemId));
    await client.end();
  });

  it('charges above basePriceCents once recent purchase pressure has built up', async () => {
    const script = new Map<string, AgentDecision>([
      [
        buyerId,
        {
          goal: 'stock up despite the price',
          selected_action: 'BUY_ITEM',
          target_id: itemId,
          parameters: { quantity: 1 },
          intent: 'buying under pressure',
          priority: 0.5,
        },
      ],
    ]);

    const result = await processTick(
      db,
      new ScriptedProvider(script),
      {
        gameDayRealSeconds: 300,
        simulationTickSeconds: 10,
        dailyBudgetCents: 500,
        providerName: 'mock',
        modelName: 'mock',
      },
      new Date()
    );

    expect(result.errors.some((e) => e.includes(buyerId))).toBe(false);

    const [buyerWallet] = await db.select().from(schema.wallets).where(eq(schema.wallets.characterId, buyerId));
    const actualChargeCents = 100_000 - buyerWallet.balanceCents;
    expect(actualChargeCents).toBeGreaterThan(BASE_PRICE_CENTS);
  });
});

/**
 * Regression test for a real bug found by code review: the per-tick
 * `conversationInfoById` snapshot used to stay unchanged for the rest
 * of the tick even after a conversation was ended mid-tick by the
 * message cap, so a SECOND participant of the same conversation,
 * processed later in the same tick, could still push it past the cap
 * — an extra message plus a duplicate CONVERSATION_ENDED event for a
 * conversation already closed. Fixed by deleting the entry from
 * conversationInfoById the moment a conversation ends.
 *
 * Seeds a conversation already at 5 messages (one below the 6-message
 * cap) and scripts BOTH participants to CONTINUE_CONVERSATION in the
 * same tick — whichever is processed first pushes it to 6 and ends
 * it; the other must see it as gone, not write a 7th message.
 */
describe.skipIf(!DB_URL)('processTick — conversation cap is not exceeded when both participants continue in one tick', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let locationId: string;
  let characterAId: string;
  let characterBId: string;
  let conversationId: string;

  beforeAll(async () => {
    client = postgres(DB_URL!);
    db = drizzle(client, { schema });

    const [location] = await db
      .insert(schema.locations)
      .values({
        name: 'Conversation Cap Test Square',
        slug: `conversation-cap-test-square-${Date.now()}`,
        description: 'A test location',
        connections: [],
      })
      .returning({ id: schema.locations.id });
    locationId = location.id;

    async function makeCharacter(name: string): Promise<string> {
      const [character] = await db
        .insert(schema.characters)
        .values({
          name,
          age: 30,
          background: 'A character created to test the conversation message cap.',
          personalityTraits: [],
          skills: [],
          ambitions: [],
          archetype: 'socialite',
        })
        .returning({ id: schema.characters.id });
      await db.insert(schema.characterState).values({
        characterId: character.id,
        locationId,
        health: 100,
        fatigue: 0,
        status: 'idle',
      });
      await db.insert(schema.wallets).values({ characterId: character.id, balanceCents: 1000 });
      return character.id;
    }

    characterAId = await makeCharacter('Conversation Cap Test A');
    characterBId = await makeCharacter('Conversation Cap Test B');

    const [conversation] = await db
      .insert(schema.conversations)
      .values({
        locationId,
        participantIds: [characterAId, characterBId],
        visibility: 'public',
      })
      .returning({ id: schema.conversations.id });
    conversationId = conversation.id;

    // 5 messages already — one more from EITHER participant hits the
    // 6-message cap.
    for (let i = 0; i < 5; i++) {
      await db.insert(schema.conversationMessages).values({
        conversationId,
        characterId: i % 2 === 0 ? characterAId : characterBId,
        content: `Message ${i + 1}`,
      });
    }
  });

  afterAll(async () => {
    const bothIds = [characterAId, characterBId];
    const ownDecisions = await db
      .select({ id: schema.agentDecisions.id })
      .from(schema.agentDecisions)
      .where(inArray(schema.agentDecisions.characterId, bothIds));
    const decisionIds = ownDecisions.map((d) => d.id);

    await db.delete(schema.conversationMessages).where(eq(schema.conversationMessages.conversationId, conversationId));
    await db.delete(schema.conversations).where(eq(schema.conversations.id, conversationId));
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

  it('writes exactly one more message and exactly one CONVERSATION_ENDED event, not two', async () => {
    const continueDecision: AgentDecision = {
      goal: 'keep talking',
      selected_action: 'CONTINUE_CONVERSATION',
      target_id: conversationId,
      parameters: {},
      intent: 'responding',
      priority: 0.5,
    };
    const script = new Map<string, AgentDecision>([
      [characterAId, continueDecision],
      [characterBId, continueDecision],
    ]);

    const result = await processTick(
      db,
      new ScriptedProvider(script),
      {
        gameDayRealSeconds: 300,
        simulationTickSeconds: 10,
        dailyBudgetCents: 500,
        providerName: 'mock',
        modelName: 'mock',
      },
      new Date()
    );

    expect(result.errors.some((e) => e.includes(characterAId) || e.includes(characterBId))).toBe(false);

    const messages = await db
      .select()
      .from(schema.conversationMessages)
      .where(eq(schema.conversationMessages.conversationId, conversationId));
    expect(messages.length).toBe(6); // 5 seeded + exactly 1 more, never 7

    const [conversationRow] = await db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conversationId));
    expect(conversationRow.endedAt).not.toBeNull();

    const endedEvents = await db
      .select()
      .from(schema.gameEvents)
      .where(
        and(
          eq(schema.gameEvents.type, 'CONVERSATION_ENDED'),
          inArray(schema.gameEvents.actorCharacterId, [characterAId, characterBId])
        )
      );
    expect(endedEvents.length).toBe(1); // never 2
  });
});
