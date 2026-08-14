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

const marketChar = { ...baseChar, locationSlug: 'market' };
const worldWithItem = { ...worldState, itemIds: ['item-1'] };

describe('validateAction - BUY_ITEM', () => {
  it('accepts buying a known item at the Market with a positive integer quantity', () => {
    const action: AgentDecision = {
      goal: 'stock up',
      selected_action: 'BUY_ITEM',
      target_id: 'item-1',
      parameters: { quantity: 2 },
      intent: 'buying food',
      priority: 0.3,
    };
    const result = validateAction(action, marketChar, worldWithItem);
    expect(result.valid).toBe(true);
  });

  it('rejects away from the Market', () => {
    const action: AgentDecision = {
      goal: 'stock up',
      selected_action: 'BUY_ITEM',
      target_id: 'item-1',
      parameters: { quantity: 1 },
      intent: 'buying food',
      priority: 0.3,
    };
    const result = validateAction(action, baseChar, worldWithItem);
    expect(result.valid).toBe(false);
  });

  it('rejects an unknown item id', () => {
    const action: AgentDecision = {
      goal: 'stock up',
      selected_action: 'BUY_ITEM',
      target_id: 'not-a-real-item',
      parameters: { quantity: 1 },
      intent: 'buying food',
      priority: 0.3,
    };
    const result = validateAction(action, marketChar, worldWithItem);
    expect(result.valid).toBe(false);
  });

  it('rejects a non-positive or non-integer quantity', () => {
    const zero: AgentDecision = {
      goal: 'stock up',
      selected_action: 'BUY_ITEM',
      target_id: 'item-1',
      parameters: { quantity: 0 },
      intent: 'buying food',
      priority: 0.3,
    };
    expect(validateAction(zero, marketChar, worldWithItem).valid).toBe(false);

    const fractional: AgentDecision = { ...zero, parameters: { quantity: 1.5 } };
    expect(validateAction(fractional, marketChar, worldWithItem).valid).toBe(false);

    const missing: AgentDecision = { ...zero, parameters: {} };
    expect(validateAction(missing, marketChar, worldWithItem).valid).toBe(false);
  });
});

describe('validateAction - SELL_ITEM', () => {
  it('accepts selling a known item at the Market', () => {
    const action: AgentDecision = {
      goal: 'raise cash',
      selected_action: 'SELL_ITEM',
      target_id: 'item-1',
      parameters: { quantity: 1 },
      intent: 'selling wood',
      priority: 0.3,
    };
    const result = validateAction(action, marketChar, worldWithItem);
    expect(result.valid).toBe(true);
  });

  it('rejects away from the Market', () => {
    const action: AgentDecision = {
      goal: 'raise cash',
      selected_action: 'SELL_ITEM',
      target_id: 'item-1',
      parameters: { quantity: 1 },
      intent: 'selling wood',
      priority: 0.3,
    };
    const result = validateAction(action, baseChar, worldWithItem);
    expect(result.valid).toBe(false);
  });
});

describe('validateAction - GIVE_ITEM', () => {
  const worldWithVisibleCharacterAndItem = {
    ...worldState,
    charactersAtSameLocation: ['char-2'],
    itemIds: ['item-1'],
  };

  it('accepts giving a known item to a visible character', () => {
    const action: AgentDecision = {
      goal: 'help a friend',
      selected_action: 'GIVE_ITEM',
      target_id: 'char-2',
      parameters: { itemId: 'item-1', quantity: 1 },
      intent: 'sharing food',
      priority: 0.3,
    };
    const result = validateAction(action, baseChar, worldWithVisibleCharacterAndItem);
    expect(result.valid).toBe(true);
  });

  it('rejects giving to yourself', () => {
    const action: AgentDecision = {
      goal: 'help a friend',
      selected_action: 'GIVE_ITEM',
      target_id: baseChar.id,
      parameters: { itemId: 'item-1', quantity: 1 },
      intent: 'sharing food',
      priority: 0.3,
    };
    const result = validateAction(
      action,
      baseChar,
      { ...worldWithVisibleCharacterAndItem, charactersAtSameLocation: [baseChar.id] }
    );
    expect(result.valid).toBe(false);
  });

  it('rejects a target not at the same location', () => {
    const action: AgentDecision = {
      goal: 'help a friend',
      selected_action: 'GIVE_ITEM',
      target_id: 'char-far-away',
      parameters: { itemId: 'item-1', quantity: 1 },
      intent: 'sharing food',
      priority: 0.3,
    };
    const result = validateAction(action, baseChar, worldWithVisibleCharacterAndItem);
    expect(result.valid).toBe(false);
  });

  it('rejects a missing or unknown itemId', () => {
    const missing: AgentDecision = {
      goal: 'help a friend',
      selected_action: 'GIVE_ITEM',
      target_id: 'char-2',
      parameters: { quantity: 1 },
      intent: 'sharing food',
      priority: 0.3,
    };
    expect(validateAction(missing, baseChar, worldWithVisibleCharacterAndItem).valid).toBe(false);

    const unknown: AgentDecision = { ...missing, parameters: { itemId: 'nope', quantity: 1 } };
    expect(validateAction(unknown, baseChar, worldWithVisibleCharacterAndItem).valid).toBe(false);
  });
});

describe('validateAction - TRANSFER_MONEY', () => {
  const worldWithVisibleCharacter = { ...worldState, charactersAtSameLocation: ['char-2'] };

  it('accepts transferring a positive integer amount to a visible character', () => {
    const action: AgentDecision = {
      goal: 'help a friend',
      selected_action: 'TRANSFER_MONEY',
      target_id: 'char-2',
      parameters: { amountCents: 500 },
      intent: 'lending a hand',
      priority: 0.3,
    };
    const result = validateAction(action, baseChar, worldWithVisibleCharacter);
    expect(result.valid).toBe(true);
  });

  it('rejects transferring to yourself', () => {
    const action: AgentDecision = {
      goal: 'help a friend',
      selected_action: 'TRANSFER_MONEY',
      target_id: baseChar.id,
      parameters: { amountCents: 500 },
      intent: 'lending a hand',
      priority: 0.3,
    };
    const result = validateAction(
      action,
      baseChar,
      { ...worldWithVisibleCharacter, charactersAtSameLocation: [baseChar.id] }
    );
    expect(result.valid).toBe(false);
  });

  it('rejects a non-positive amount', () => {
    const action: AgentDecision = {
      goal: 'help a friend',
      selected_action: 'TRANSFER_MONEY',
      target_id: 'char-2',
      parameters: { amountCents: -100 },
      intent: 'lending a hand',
      priority: 0.3,
    };
    const result = validateAction(action, baseChar, worldWithVisibleCharacter);
    expect(result.valid).toBe(false);
  });
});
