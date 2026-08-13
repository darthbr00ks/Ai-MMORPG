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
