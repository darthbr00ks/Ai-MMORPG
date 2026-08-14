import { z } from 'zod';

export const ACTION_NAMES = [
  'IDLE',
  'MOVE',
  'WORK',
  'START_CONVERSATION',
  'CONTINUE_CONVERSATION',
  'BUY_ITEM',
  'SELL_ITEM',
  'GIVE_ITEM',
  'TRANSFER_MONEY',
] as const;

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
  {
    name: 'START_CONVERSATION',
    description:
      'Begin talking with another character who is visible at your current location. target_id must be that character\'s id.',
    requiresTarget: true,
    parameters: ['topic'],
  },
  {
    name: 'CONTINUE_CONVERSATION',
    description:
      'Continue a conversation you are already part of. target_id must be the conversation\'s id.',
    requiresTarget: true,
    parameters: ['message_intent'],
  },
  {
    name: 'BUY_ITEM',
    description:
      'Buy an item from the market at your current location (Market only). target_id must be the item\'s id; parameters.quantity is how many to buy.',
    requiresTarget: true,
    parameters: ['quantity'],
  },
  {
    name: 'SELL_ITEM',
    description:
      'Sell an item from your inventory to the market at your current location (Market only). target_id must be the item\'s id; parameters.quantity is how many to sell.',
    requiresTarget: true,
    parameters: ['quantity'],
  },
  {
    name: 'GIVE_ITEM',
    description:
      'Give an item from your inventory to another character visible at your current location. target_id must be that character\'s id; parameters.itemId and parameters.quantity specify what to give.',
    requiresTarget: true,
    parameters: ['itemId', 'quantity'],
  },
  {
    name: 'TRANSFER_MONEY',
    description:
      'Give money from your wallet to another character visible at your current location. target_id must be that character\'s id; parameters.amountCents is how much.',
    requiresTarget: true,
    parameters: ['amountCents'],
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
