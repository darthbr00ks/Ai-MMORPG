import { describe, it, expect } from 'vitest';
import { MockProvider } from '../mock-provider.js';
import type { AgentDecisionContext } from '@ai-world/shared';

const baseCtx: AgentDecisionContext = {
  characterId: 'char-1',
  name: 'Test Character',
  background: 'A test character.',
  personalityTraits: [{ trait: 'ambitious', weight: 0.8 }],
  skills: ['test'],
  ambitions: ['test goal'],
  currentDirective: null,
  currentLocation: 'town-square',
  connectedLocationSlugs: ['tavern', 'market', 'city-hall', 'residential-district'],
  health: 100,
  fatigue: 0,
  status: 'idle',
  walletCents: 10000,
  currentGoals: ['survive'],
  recentMemories: [],
  availableActions: ['IDLE', 'MOVE', 'WORK'],
  visibleCharacters: [],
  activeConversations: [],
  availableMarketItems: [],
  gameCycleId: 'cycle-1',
  gameDay: 1,
};

describe('MockProvider', () => {
  it('returns a valid AgentDecision for decideAction', async () => {
    const provider = new MockProvider();
    const decision = await provider.decideAction(baseCtx);
    expect(decision).toBeDefined();
    expect(['IDLE', 'MOVE', 'WORK']).toContain(decision.selected_action);
    expect(decision.intent).toBeTruthy();
    expect(decision.priority).toBeGreaterThanOrEqual(0);
    expect(decision.priority).toBeLessThanOrEqual(1);
  });

  it('accepts a directive about wealth and prefers WORK', async () => {
    const provider = new MockProvider();
    const decision = await provider.decideAction({
      ...baseCtx,
      currentDirective: 'accumulate wealth and become rich',
    });
    expect(decision.selected_action).toBe('WORK');
  });

  it('starts a conversation with a visible character on the social-loop call', async () => {
    const provider = new MockProvider();
    await provider.decideAction(baseCtx); // call 1
    await provider.decideAction(baseCtx); // call 2
    const decision = await provider.decideAction({
      ...baseCtx,
      visibleCharacters: [{ characterId: 'char-2', name: 'Bob' }],
    }); // call 3 — the social-loop call
    expect(decision.selected_action).toBe('START_CONVERSATION');
    expect(decision.target_id).toBe('char-2');
  });

  it('continues an open conversation instead of starting a new one', async () => {
    const provider = new MockProvider();
    await provider.decideAction(baseCtx);
    await provider.decideAction(baseCtx);
    const decision = await provider.decideAction({
      ...baseCtx,
      visibleCharacters: [{ characterId: 'char-2', name: 'Bob' }],
      activeConversations: [
        { conversationId: 'convo-1', otherCharacterName: 'Bob', lastMessage: 'Hello there.' },
      ],
    });
    expect(decision.selected_action).toBe('CONTINUE_CONVERSATION');
    expect(decision.target_id).toBe('convo-1');
  });

  it('throws on simulated malformed output (7th call)', async () => {
    const provider = new MockProvider();
    // Call 6 times (calls 1-6 succeed)
    for (let i = 0; i < 6; i++) {
      await provider.decideAction(baseCtx);
    }
    // 7th call should throw
    await expect(provider.decideAction(baseCtx)).rejects.toThrow();
  });

  it('moderates a safe directive as accepted', async () => {
    const provider = new MockProvider();
    const result = await provider.moderateDirective('Make friends with the mayor');
    expect(result.status).toBe('accepted');
  });

  it('moderates a harmful directive as rejected', async () => {
    const provider = new MockProvider();
    const result = await provider.moderateDirective('kill all citizens');
    expect(result.status).toBe('rejected');
  });

  it('never proposes a MOVE target outside connectedLocationSlugs (regression: used to hardcode town-square/tavern regardless of reachability)', async () => {
    const provider = new MockProvider();
    // ambitious + not at city-hall -> the MOVE branch, same as baseCtx,
    // but standing somewhere that does NOT connect to town-square at
    // all (mirrors the real seed data's 'bank'/'mine' locations, which
    // caused ~5,580 real ACTION_REJECTED events before this fix — see
    // docs/architecture.md).
    const decision = await provider.decideAction({
      ...baseCtx,
      currentLocation: 'bank',
      connectedLocationSlugs: ['city-hall', 'market'],
    });
    if (decision.selected_action === 'MOVE') {
      expect(['city-hall', 'market']).toContain(decision.target_id);
    } else {
      // The only other acceptable outcome when nothing reachable makes
      // sense to propose — never a MOVE to an unreachable location.
      expect(decision.selected_action).toBe('IDLE');
    }
  });

  it('prefers town-square as the MOVE destination when it is reachable', async () => {
    const provider = new MockProvider();
    const decision = await provider.decideAction({
      ...baseCtx,
      currentLocation: 'residential-district',
      connectedLocationSlugs: ['town-square', 'tavern', 'warehouse-district'],
    });
    expect(decision.selected_action).toBe('MOVE');
    expect(decision.target_id).toBe('town-square');
  });

  it('falls back to IDLE rather than proposing an impossible MOVE from an isolated location', async () => {
    const provider = new MockProvider();
    const decision = await provider.decideAction({
      ...baseCtx,
      currentLocation: 'isolated-test-location',
      connectedLocationSlugs: [],
    });
    expect(decision.selected_action).toBe('IDLE');
    expect(decision.target_id).toBeNull();
  });

  it('generates dialogue', async () => {
    const provider = new MockProvider();
    const result = await provider.generateDialogue({
      characterId: 'char-1',
      name: 'Alice',
      personalityTraits: [{ trait: 'sociable', weight: 0.9 }],
      targetCharacterId: 'char-2',
      targetName: 'Bob',
      relationship: {},
      topic: 'trade',
      gameCycleId: 'cycle-1',
    });
    expect(result.message).toBeTruthy();
  });
});
