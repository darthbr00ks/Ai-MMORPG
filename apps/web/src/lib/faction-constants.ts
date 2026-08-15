/** Shared visual constants for faction rank rendering used by both
 * WorldMap.tsx and DiplomacyView.tsx. */

export type FactionRank = 'leader' | 'commander' | 'captain' | 'lieutenant' | 'member';

/** Unicode icon for each faction rank. Empty string = no badge (member). */
export const RANK_ICON: Record<FactionRank, string> = {
  leader: '👑',
  commander: '⚔',
  captain: '◆',
  lieutenant: '▲',
  member: '',
};

/** Sort order for faction ranks (lower = higher in hierarchy). */
export const RANK_ORDER: Record<FactionRank, number> = {
  leader: 0,
  commander: 1,
  captain: 2,
  lieutenant: 3,
  member: 4,
};
