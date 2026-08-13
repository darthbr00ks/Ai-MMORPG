import type { AgentDecision } from '@ai-world/shared';
import { ACTION_NAMES } from '@ai-world/shared';
import type { Location } from './movement.js';
import { isLocationConnected } from './movement.js';

export interface CharacterContext {
  id: string;
  locationSlug: string;
  status: string;
  walletCents: number;
  health: number;
  fatigue: number;
}

export interface WorldState {
  locations: Location[];
  currentGameDay: number;
}

export interface ValidationReport {
  valid: boolean;
  reason?: string;
}

export function validateAction(
  action: AgentDecision,
  character: CharacterContext,
  world: WorldState
): ValidationReport {
  // Ensure the action name is in the registry
  if (!ACTION_NAMES.includes(action.selected_action)) {
    return { valid: false, reason: `Unknown action: ${action.selected_action}` };
  }

  switch (action.selected_action) {
    case 'IDLE':
      return { valid: true };

    case 'MOVE': {
      if (!action.target_id) {
        return { valid: false, reason: 'MOVE requires a target_id (destination location slug)' };
      }
      if (action.target_id === character.locationSlug) {
        return { valid: false, reason: 'Already at destination' };
      }
      if (character.status === 'traveling') {
        return { valid: false, reason: 'Already traveling' };
      }
      if (!isLocationConnected(character.locationSlug, action.target_id, world.locations)) {
        return {
          valid: false,
          reason: `Location '${action.target_id}' is not connected to '${character.locationSlug}'`,
        };
      }
      return { valid: true };
    }

    case 'WORK': {
      if (character.health < 20) {
        return { valid: false, reason: 'Too unhealthy to work' };
      }
      if (character.fatigue > 90) {
        return { valid: false, reason: 'Too fatigued to work' };
      }
      if (character.status === 'traveling') {
        return { valid: false, reason: 'Cannot work while traveling' };
      }
      return { valid: true };
    }

    default:
      return { valid: false, reason: `Unhandled action type: ${action.selected_action}` };
  }
}
