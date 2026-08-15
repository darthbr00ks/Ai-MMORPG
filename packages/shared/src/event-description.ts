/**
 * Turns a raw GameEvent into the one-line, human-readable form the
 * model actually needs — used by both memory extraction (Phase 11)
 * and the daily player report (Phase 13). The model summarizes
 * narrative, it never sees raw payload JSON; this is the one place
 * that mapping is defined, so the two features never drift apart.
 */
export function describeGameEvent(event: { type: string; payload: unknown }): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case 'CHARACTER_MOVED':
      return `Moved to ${payload.to_location_name ?? payload.destination ?? 'a new location'}.`;
    case 'MONEY_EARNED':
      return `Earned ${payload.amount_cents ?? 0} cents working.`;
    case 'CONVERSATION_STARTED':
      return `Started a conversation: "${payload.message ?? ''}"`;
    case 'CONVERSATION_MESSAGE':
      return `Said: "${payload.message ?? ''}"`;
    case 'CONVERSATION_ENDED':
      return 'A conversation came to an end.';
    case 'RELATIONSHIP_CHANGED':
      return `A relationship shifted (${payload.effect ?? 'an interaction'}).`;
    case 'ACTION_REJECTED':
      return `Tried something that didn't work out: ${payload.reason ?? 'unknown reason'}.`;
    case 'CHARACTER_IDLE':
      return 'Rested and observed the world.';
    case 'ITEM_PURCHASED':
      return `Bought ${payload.quantity ?? ''} ${payload.item_name ?? 'goods'} at the market.`;
    case 'ITEM_SOLD':
      return `Sold ${payload.quantity ?? ''} ${payload.item_name ?? 'goods'} at the market.`;
    case 'ITEM_GIVEN':
      return `Gave ${payload.quantity ?? ''} ${payload.item_name ?? 'an item'} to someone.`;
    case 'MONEY_TRANSFERRED':
      return `Gave ${payload.amount_cents ?? 0} cents to someone.`;
    case 'CHARACTER_ATE':
      return `Ate ${payload.quantity_consumed ?? ''} ${payload.item_name ?? 'food'} from stores.`;
    case 'CHARACTER_STARVING':
      return `Went hungry with nothing left to eat — health suffering for it.`;
    default:
      return event.type.replace(/_/g, ' ').toLowerCase();
  }
}
