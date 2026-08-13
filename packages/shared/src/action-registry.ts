import { z } from 'zod';

export const ACTION_NAMES = ['IDLE', 'MOVE', 'WORK'] as const;

export type ActionName = (typeof ACTION_NAMES)[number];

export interface ActionDefinition {
  name: ActionName;
  description: string;
  requiresTarget: boolean;
  parameters: string[];
}

export const ACTION_REGISTRY: ActionDefinition[] = [
  {
    name: 'IDLE',
    description: 'Do nothing this tick. Rest or think.',
    requiresTarget: false,
    parameters: [],
  },
  {
    name: 'MOVE',
    description: 'Move to a connected location.',
    requiresTarget: true,
    parameters: ['destination_location_id'],
  },
  {
    name: 'WORK',
    description: 'Work at current location if employment is available.',
    requiresTarget: false,
    parameters: ['job_type'],
  },
];

export const AgentDecisionSchema = z.object({
  goal: z.string(),
  selected_action: z.enum(ACTION_NAMES),
  target_id: z.string().nullable().optional(),
  parameters: z.record(z.unknown()).optional().default({}),
  intent: z.string(),
  priority: z.number().min(0).max(1),
});

export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

export const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string' },
    selected_action: { type: 'string', enum: ACTION_NAMES },
    target_id: { type: ['string', 'null'] },
    parameters: { type: 'object' },
    intent: { type: 'string' },
    priority: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['goal', 'selected_action', 'intent', 'priority'],
  additionalProperties: false,
} as const;
