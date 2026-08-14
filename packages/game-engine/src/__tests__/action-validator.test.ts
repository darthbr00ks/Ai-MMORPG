import { describe, it, expect } from 'vitest';
import { validateAction } from '../action-validator.js';
import type { AgentDecision } from '@ai-world/shared';

const testLocations = [
  { id: '1', slug: 'town-square', connections: ['tavern', 'market'] },
  { id: '2', slug: 'tavern', connections: ['town-square'] },
  { id: '3', slug: 'market', connections: ['town-square'] },
];

const worldState = {
  locations: testLocations,
  currentGameDay: 1,
};

const baseChar = {
  id: 'char-1',
  locationSlug: 'town-square',
  status: 'idle',
  walletCents: 10000,
  health: 100,
  fatigue: 0,
};

describe('validateAction - IDLE', () => {
  it('always accepts IDLE', () => {
    const action: AgentDecision = {
      goal: 'rest',
      selected_action: 'IDLE',
      target_id: null,
      parameters: {},
      intent: 'resting',
      priority: 0.3,
    };
    const result = validateAction(action, baseChar, worldState);
    expect(result.valid).toBe(true);
  });
});

describe('validateAction - MOVE', () => {
  it('accepts MOVE to connected location', () => {
    const action: AgentDecision = {
      goal: 'explore',
      selected_action: 'MOVE',
      target_id: 'tavern',
      parameters: {},
      intent: 'going to tavern',
      priority: 0.5,
    };
    const result = validateAction(action, baseChar, worldState);
    expect(result.valid).toBe(true);
  });

  it('rejects MOVE to non-connected location', () => {
    const action: AgentDecision = {
      goal: 'explore',
      selected_action: 'MOVE',
      target_id: 'mine',
      parameters: {},
      intent: 'going to mine',
      priority: 0.5,
    };
    const result = validateAction(action, baseChar, worldState);
    expect(result.valid).toBe(false);
  });

  it('rejects MOVE without target_id', () => {
    const action: AgentDecision = {
      goal: 'explore',
      selected_action: 'MOVE',
      target_id: null,
      parameters: {},
      intent: 'going somewhere',
      priority: 0.5,
    };
    const result = validateAction(action, baseChar, worldState);
    expect(result.valid).toBe(false);
  });

  it('rejects MOVE while traveling', () => {
    const action: AgentDecision = {
      goal: 'explore',
      selected_action: 'MOVE',
      target_id: 'tavern',
      parameters: {},
      intent: 'going to tavern',
      priority: 0.5,
    };
    const result = validateAction(action, { ...baseChar, status: 'traveling' }, worldState);
    expect(result.valid).toBe(false);
  });
});

describe('validateAction - WORK', () => {
  it('accepts WORK for healthy character', () => {
    const action: AgentDecision = {
      goal: 'earn money',
      selected_action: 'WORK',
      target_id: null,
      parameters: {},
      intent: 'working for wages',
      priority: 0.7,
    };
    const result = validateAction(action, baseChar, worldState);
    expect(result.valid).toBe(true);
  });

  it('rejects WORK when too fatigued', () => {
    const action: AgentDecision = {
      goal: 'earn money',
      selected_action: 'WORK',
      target_id: null,
      parameters: {},
      intent: 'working for wages',
      priority: 0.7,
    };
    const result = validateAction(action, { ...baseChar, fatigue: 95 }, worldState);
    expect(result.valid).toBe(false);
  });

  it('rejects WORK when unhealthy', () => {
    const action: AgentDecision = {
      goal: 'earn money',
      selected_action: 'WORK',
      target_id: null,
      parameters: {},
      intent: 'working for wages',
      priority: 0.7,
    };
    const result = validateAction(action, { ...baseChar, health: 10 }, worldState);
    expect(result.valid).toBe(false);
  });

  it('rejects WORK while traveling', () => {
    const action: AgentDecision = {
      goal: 'earn money',
      selected_action: 'WORK',
      target_id: null,
      parameters: {},
      intent: 'working for wages',
      priority: 0.7,
    };
    const result = validateAction(action, { ...baseChar, status: 'traveling' }, worldState);
    expect(result.valid).toBe(false);
  });
});

describe('validateAction - START_CONVERSATION', () => {
  const worldWithVisibleCharacter = {
    ...worldState,
    charactersAtSameLocation: ['char-2'],
  };

  it('accepts starting a conversation with a visible character', () => {
    const action: AgentDecision = {
      goal: 'socialize',
      selected_action: 'START_CONVERSATION',
      target_id: 'char-2',
      parameters: { topic: 'the harvest' },
      intent: 'greeting a neighbor',
      priority: 0.4,
    };
    const result = validateAction(action, baseChar, worldWithVisibleCharacter);
    expect(result.valid).toBe(true);
  });

  it('rejects without a target_id', () => {
    const action: AgentDecision = {
      goal: 'socialize',
      selected_action: 'START_CONVERSATION',
      target_id: null,
      parameters: {},
      intent: 'greeting a neighbor',
      priority: 0.4,
    };
    const result = validateAction(action, baseChar, worldWithVisibleCharacter);
    expect(result.valid).toBe(false);
  });

  it('rejects talking to yourself', () => {
    const action: AgentDecision = {
      goal: 'socialize',
      selected_action: 'START_CONVERSATION',
      target_id: baseChar.id,
      parameters: {},
      intent: 'greeting a neighbor',
      priority: 0.4,
    };
    const result = validateAction(
      action,
      baseChar,
      { ...worldState, charactersAtSameLocation: [baseChar.id] }
    );
    expect(result.valid).toBe(false);
  });

  it('rejects a target character not at the same location', () => {
    const action: AgentDecision = {
      goal: 'socialize',
      selected_action: 'START_CONVERSATION',
      target_id: 'char-far-away',
      parameters: {},
      intent: 'greeting a neighbor',
      priority: 0.4,
    };
    const result = validateAction(action, baseChar, worldWithVisibleCharacter);
    expect(result.valid).toBe(false);
  });

  it('rejects starting a conversation while traveling', () => {
    const action: AgentDecision = {
      goal: 'socialize',
      selected_action: 'START_CONVERSATION',
      target_id: 'char-2',
      parameters: {},
      intent: 'greeting a neighbor',
      priority: 0.4,
    };
    const result = validateAction(
      action,
      { ...baseChar, status: 'traveling' },
      worldWithVisibleCharacter
    );
    expect(result.valid).toBe(false);
  });
});

describe('validateAction - CONTINUE_CONVERSATION', () => {
  const worldWithOpenConversation = {
    ...worldState,
    activeConversationIds: ['convo-1'],
  };

  it('accepts continuing an open conversation', () => {
    const action: AgentDecision = {
      goal: 'keep talking',
      selected_action: 'CONTINUE_CONVERSATION',
      target_id: 'convo-1',
      parameters: {},
      intent: 'responding',
      priority: 0.4,
    };
    const result = validateAction(action, baseChar, worldWithOpenConversation);
    expect(result.valid).toBe(true);
  });

  it('rejects a conversation id this character does not have open', () => {
    const action: AgentDecision = {
      goal: 'keep talking',
      selected_action: 'CONTINUE_CONVERSATION',
      target_id: 'convo-does-not-exist',
      parameters: {},
      intent: 'responding',
      priority: 0.4,
    };
    const result = validateAction(action, baseChar, worldWithOpenConversation);
    expect(result.valid).toBe(false);
  });

  it('rejects without a target_id', () => {
    const action: AgentDecision = {
      goal: 'keep talking',
      selected_action: 'CONTINUE_CONVERSATION',
      target_id: null,
      parameters: {},
      intent: 'responding',
      priority: 0.4,
    };
    const result = validateAction(action, baseChar, worldWithOpenConversation);
    expect(result.valid).toBe(false);
  });
});
