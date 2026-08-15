'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CharacterAvatar } from '@/components/CharacterAvatar';
import {
  LOCATION_LAYOUT,
  WORLD_MAP_VIEWBOX,
  characterOffsetWithinLocation,
  type WorldMapPoint,
  type LocationNodeType,
} from '@/lib/world-layout';
import type {
  WorldSnapshot,
  WorldSnapshotCharacter,
  WorldSnapshotLocation,
} from '@/app/api/world/snapshot/route';
import DiplomacyView from '@/components/DiplomacyView';
import { RANK_ICON } from '@/lib/faction-constants';

const SNAPSHOT_POLL_MS = 5000;
const AVATAR_SIZE = 40;
// Clears the widest character fan-out ring (characterOffsetWithinLocation's
// 46px radius + half an avatar + its status ring) so a crowded hub's
// location name never sits under its own characters.
const LOCATION_LABEL_OFFSET_Y = 78;

const STATUS_RING_COLOR: Record<WorldSnapshotCharacter['status'], string> = {
  idle: '#9CA3AF', // gray-400
  working: '#F2C14E', // gold, matches CharacterAvatar's warm palette
  traveling: '#7FB2E5', // sky
  conversing: '#6FBF9E', // sage
  sleeping: '#9E9BE0', // lavender
  planning: '#E4A6D6', // orchid
};

// ─── Location icons ───────────────────────────────────────────────────────────

/** Small themed SVG icon rendered inside each location node circle. */
function LocationIcon({
  type,
  cx,
  cy,
  r,
}: {
  type: LocationNodeType;
  cx: number;
  cy: number;
  r: number;
}) {
  const bg = (
    <circle cx={cx} cy={cy} r={r} fill="#1e2535" stroke="#3a4060" strokeWidth={1.5} />
  );

  switch (type) {
    case 'tavern':
      return (
        <g>
          {bg}
          <g transform={`translate(${cx - 8}, ${cy - 9})`}>
            <rect x={1} y={2} width={12} height={13} rx={2} fill="#D97706" />
            <rect x={11} y={4} width={4} height={7} rx={2} fill="#D97706" />
            <rect x={2} y={0} width={10} height={3} rx={1} fill="#92400E" />
            <path d="M2 8 L12 8" stroke="#92400E" strokeWidth={1} opacity={0.4} />
          </g>
        </g>
      );
    case 'market':
      return (
        <g>
          {bg}
          <g transform={`translate(${cx - 10}, ${cy - 9})`}>
            <rect x={0} y={6} width={20} height={8} rx={1} fill="#9D8B5A" />
            <path d="M0 6 Q5 0 10 6 Q15 0 20 6" fill="#B45309" />
            <line x1={0} y1={14} x2={0} y2={16} stroke="#9D8B5A" strokeWidth={1.5} />
            <line x1={20} y1={14} x2={20} y2={16} stroke="#9D8B5A" strokeWidth={1.5} />
          </g>
        </g>
      );
    case 'home':
      return (
        <g>
          {bg}
          <g transform={`translate(${cx - 9}, ${cy - 9})`}>
            <path d="M9 0 L18 8 L0 8 Z" fill="#B45309" />
            <rect x={3} y={8} width={12} height={9} rx={1} fill="#92400E" />
            <rect x={7} y={11} width={4} height={6} rx={1} fill="#1e2535" />
          </g>
        </g>
      );
    case 'cityhall':
      return (
        <g>
          {bg}
          <g transform={`translate(${cx - 10}, ${cy - 10})`}>
            <rect x={1} y={8} width={18} height={11} fill="#6B7280" />
            <path d="M0 8 L10 2 L20 8" fill="#9CA3AF" />
            {[3, 7, 11, 15].map((xo) => (
              <line key={xo} x1={xo} y1={8} x2={xo} y2={19} stroke="#4B5563" strokeWidth={1.5} />
            ))}
            <rect x={7} y={13} width={6} height={6} fill="#1e2535" />
          </g>
        </g>
      );
    case 'warehouse':
      return (
        <g>
          {bg}
          <g transform={`translate(${cx - 10}, ${cy - 9})`}>
            <path d="M0 7 L10 1 L20 7" fill="#78716C" />
            <rect x={0} y={7} width={20} height={10} fill="#57534E" />
            <rect x={7} y={11} width={6} height={6} fill="#44403C" />
          </g>
        </g>
      );
    case 'farm':
      return (
        <g>
          {bg}
          <g transform={`translate(${cx - 8}, ${cy - 10})`}>
            {[-4, 0, 4, 8, 12].map((xo, i) => (
              <g key={i} transform={`translate(${xo}, 0)`}>
                <line x1={2} y1={18} x2={2} y2={6} stroke="#A16207" strokeWidth={1.5} />
                <ellipse cx={2} cy={4} rx={2} ry={5} fill="#CA8A04" />
              </g>
            ))}
          </g>
        </g>
      );
    case 'bank':
      return (
        <g>
          {bg}
          <g transform={`translate(${cx - 10}, ${cy - 9})`}>
            <rect x={0} y={5} width={20} height={11} fill="#6B7280" />
            <rect x={0} y={2} width={20} height={3} fill="#9CA3AF" />
            <rect x={0} y={14} width={20} height={2} fill="#9CA3AF" />
            {[2, 6, 10, 14].map((xo) => (
              <rect key={xo} x={xo} y={5} width={2} height={9} fill="#4B5563" />
            ))}
          </g>
        </g>
      );
    case 'mine':
      return (
        <g>
          {bg}
          <g transform={`translate(${cx - 10}, ${cy - 10})`}>
            <line x1={3} y1={17} x2={17} y2={3} stroke="#9CA3AF" strokeWidth={2.5} strokeLinecap="round" />
            <path d="M3 17 L0 20 L3 19 L4 16 Z" fill="#6B7280" />
            <path d="M17 3 L14 0 L19 1 L20 6 L17 3Z" fill="#78716C" />
          </g>
        </g>
      );
    case 'guard':
      return (
        <g>
          {bg}
          <g transform={`translate(${cx - 9}, ${cy - 10})`}>
            <path d="M9 0 L18 4 L18 12 Q18 18 9 20 Q0 18 0 12 L0 4 Z" fill="#1D4ED8" />
            <path d="M9 3 L15 6 L15 12 Q15 17 9 18 Q3 17 3 12 L3 6 Z" fill="#3B82F6" />
            <line x1={9} y1={6} x2={9} y2={16} stroke="#fff" strokeWidth={1.5} opacity={0.6} />
            <line x1={5} y1={11} x2={13} y2={11} stroke="#fff" strokeWidth={1.5} opacity={0.6} />
          </g>
        </g>
      );
    case 'plaza':
    default:
      return (
        <g>
          {bg}
          <g transform={`translate(${cx - 9}, ${cy - 9})`}>
            <circle cx={9} cy={9} r={7} fill="#1e2535" stroke="#60A5FA" strokeWidth={1.5} />
            <circle cx={9} cy={9} r={4} fill="#1D4ED8" opacity={0.6} />
            <line x1={9} y1={4} x2={9} y2={14} stroke="#7FB2E5" strokeWidth={1.5} opacity={0.7} />
            <line x1={4} y1={9} x2={14} y2={9} stroke="#7FB2E5" strokeWidth={1.5} opacity={0.7} />
            <circle cx={9} cy={9} r={2} fill="#7FB2E5" opacity={0.8} />
          </g>
        </g>
      );
  }
}

// ─── Rank badge ───────────────────────────────────────────────────────────────

function RankBadge({ rank }: { rank: NonNullable<WorldSnapshotCharacter['factionRank']> }) {
  const icon = RANK_ICON[rank];
  if (!icon) return null;
  return (
    <text
      x={AVATAR_SIZE / 2 - 2}
      y={-AVATAR_SIZE / 2 + 2}
      textAnchor="middle"
      dominantBaseline="hanging"
      fontSize={rank === 'leader' ? 11 : 9}
      style={{ filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.8))' }}
    >
      {icon}
    </text>
  );
}

// ─── Wealth badge ───────────────────────────────────────────────────────────────

// 3x the alpha's starting wallet (DEFAULT_STARTING_CURRENCY_CENTS,
// 10000¢) — comfortably above what a few days of ordinary WORK/BUY_ITEM
// activity would produce by chance, so the badge reads as "doing
// noticeably well," not "played the game for an hour." No equivalent
// server-side concept exists (or should — this is a spectator-only
// visual tell, not a game mechanic with rules attached), so the
// threshold lives here rather than in shared config.
const WEALTHY_WALLET_THRESHOLD_CENTS = 30_000;

/** Bottom-right corner badge — the wealth-tell counterpart to
 * RankBadge's top-right faction rank. Bottom corner specifically so
 * the two never collide on a character who is both wealthy and
 * ranked. */
function WealthBadge() {
  return (
    <text
      x={AVATAR_SIZE / 2 - 2}
      y={AVATAR_SIZE / 2 - 2}
      textAnchor="middle"
      dominantBaseline="auto"
      fontSize={11}
      style={{ filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.8))' }}
    >
      💰
    </text>
  );
}

// ─── Effect types ─────────────────────────────────────────────────────────────

interface RawStreamEvent {
  id: string;
  type: string;
  actorCharacterId: string | null;
  targetCharacterId: string | null;
  locationId: string | null;
  payload: Record<string, unknown>;
}

type EphemeralEffect =
  | { id: string; kind: 'speech'; characterId: string; text: string; fadingOut: boolean }
  | { id: string; kind: 'toast'; characterId: string; text: string; fadingOut: boolean }
  | { id: string; kind: 'emoji'; characterId: string; emoji: string; fadingOut: boolean }
  | {
      id: string;
      kind: 'travel';
      fromLocationId: string;
      toLocationId: string;
      fadingOut: boolean;
    }
  | { id: string; kind: 'faction-banner'; text: string; fadingOut: boolean };

const SPEECH_LIFETIME_MS = 5000;
const TOAST_LIFETIME_MS = 2200;
const EMOJI_LIFETIME_MS = 2800;
const TRAVEL_PULSE_LIFETIME_MS = 3500;
const FACTION_BANNER_LIFETIME_MS = 7000;
const FADE_MS = 500;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** What a MONEY_EARNED / ITEM_(PURCHASED|SOLD|GIVEN) / MONEY_TRANSFERRED
 * event should float up as a toast, or null if this event type isn't
 * one WorldMap renders a toast for. */
function toastTextFor(event: RawStreamEvent): string | null {
  const payload = event.payload;
  switch (event.type) {
    case 'MONEY_EARNED':
      return `+${(payload.amount_cents as number | undefined) ?? 0}¢`;
    case 'MONEY_TRANSFERRED':
      return `-${(payload.amount_cents as number | undefined) ?? 0}¢`;
    case 'ITEM_PURCHASED':
      return `bought ${(payload.item_name as string | undefined) ?? 'goods'}`;
    case 'ITEM_SOLD':
      return `sold ${(payload.item_name as string | undefined) ?? 'goods'}`;
    case 'ITEM_GIVEN':
      return `gave away ${(payload.item_name as string | undefined) ?? 'an item'}`;
    default:
      return null;
  }
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * Live top-down view of New Concord — location nodes rendered as themed
 * SVG icons, character avatars standing at their current location with
 * smooth CSS-transition movement, status/faction color rings, rank badges,
 * speech bubbles, and floating effects for what's happening right now.
 *
 * Two independent data sources:
 *  - /api/world/snapshot, polled every SNAPSHOT_POLL_MS — authoritative
 *    position (including faction/rank data). Self-healing.
 *  - /api/events/stream (SSE) — layered on top for transient effects only.
 *
 * A view-mode toggle switches to <DiplomacyView> (faction clusters +
 * relationship edges) without unmounting the polling above.
 */
export default function WorldMap() {
  const [viewMode, setViewMode] = useState<'world' | 'diplomacy'>('world');
  const [snapshot, setSnapshot] = useState<WorldSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState(false);
  // Optimistic location overrides applied immediately from CHARACTER_MOVED
  // events so movement reads as live rather than waiting up to
  // SNAPSHOT_POLL_MS for the next poll.
  const [locationOverrideByCharacterId, setLocationOverrideByCharacterId] = useState<
    Record<string, string>
  >({});
  const [effects, setEffects] = useState<EphemeralEffect[]>([]);
  const effectTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const pushEffect = useCallback((effect: EphemeralEffect, lifetimeMs: number) => {
    setEffects((prev) => [...prev, effect]);
    const fadeTimer = setTimeout(() => {
      setEffects((prev) => prev.map((e) => (e.id === effect.id ? { ...e, fadingOut: true } : e)));
    }, lifetimeMs - FADE_MS);
    const removeTimer = setTimeout(() => {
      setEffects((prev) => prev.filter((e) => e.id !== effect.id));
    }, lifetimeMs);
    effectTimeoutsRef.current.add(fadeTimer).add(removeTimer);
  }, []);

  // Snapshot poll — the authoritative source (see doc comment above).
  useEffect(() => {
    let cancelled = false;
    async function pollOnce() {
      try {
        const res = await fetch('/api/world/snapshot');
        if (!res.ok) throw new Error(`snapshot fetch failed: ${res.status}`);
        const data = (await res.json()) as WorldSnapshot;
        if (!cancelled) {
          setSnapshot(data);
          setSnapshotError(false);
          setLocationOverrideByCharacterId({});
        }
      } catch {
        if (!cancelled) setSnapshotError(true);
      }
    }
    pollOnce();
    const interval = setInterval(pollOnce, SNAPSHOT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // SSE effects layer — unchanged /api/events/stream, consumed here only
  // for transient visuals.
  useEffect(() => {
    const evtSource = new EventSource('/api/events/stream');

    evtSource.onmessage = (e) => {
      let event: RawStreamEvent;
      try {
        event = JSON.parse(e.data) as RawStreamEvent;
      } catch {
        return;
      }

      if (
        (event.type === 'CONVERSATION_STARTED' || event.type === 'CONVERSATION_MESSAGE') &&
        event.actorCharacterId &&
        typeof event.payload.message === 'string'
      ) {
        pushEffect(
          {
            id: event.id,
            kind: 'speech',
            characterId: event.actorCharacterId,
            text: truncate(event.payload.message, 90),
            fadingOut: false,
          },
          SPEECH_LIFETIME_MS
        );
        return;
      }

      if (event.type === 'CHARACTER_MOVED' && event.actorCharacterId && event.locationId) {
        setLocationOverrideByCharacterId((prev) => ({
          ...prev,
          [event.actorCharacterId as string]: event.locationId as string,
        }));
        const destinationId =
          (event.payload.destination_id as string | undefined) ??
          (event.payload.to_location_id as string | undefined);
        if (destinationId && destinationId !== event.locationId) {
          pushEffect(
            {
              id: event.id,
              kind: 'travel',
              fromLocationId: event.locationId,
              toLocationId: destinationId,
              fadingOut: false,
            },
            TRAVEL_PULSE_LIFETIME_MS
          );
        }
        return;
      }

      // Faction founded — big announcement banner
      if (event.type === 'FACTION_FOUNDED') {
        const factionName = (event.payload.faction_name as string | undefined) ?? 'A new faction';
        const leaderName = (event.payload.leader_name as string | undefined) ?? 'someone';
        pushEffect(
          {
            id: event.id,
            kind: 'faction-banner',
            text: `⚑ ${factionName} has been founded — ${leaderName} named as its first leader.`,
            fadingOut: false,
          },
          FACTION_BANNER_LIFETIME_MS
        );
        return;
      }

      // Leadership challenge result — banner + emoji on challenger
      if (event.type === 'LEADERSHIP_CHALLENGED') {
        const outcome = (event.payload.outcome as string | undefined) ?? '';
        const challenger = (event.payload.challenger_name as string | undefined) ?? 'someone';
        const target = (event.payload.target_name as string | undefined) ?? 'someone';
        const text =
          outcome === 'challenger_wins'
            ? `⚔ ${challenger} has seized leadership from ${target}!`
            : `⚔ ${challenger} challenged ${target} for leadership — and failed.`;
        pushEffect(
          { id: event.id, kind: 'faction-banner', text, fadingOut: false },
          FACTION_BANNER_LIFETIME_MS
        );
        if (event.actorCharacterId) {
          pushEffect(
            { id: `${event.id}-emoji`, kind: 'emoji', characterId: event.actorCharacterId, emoji: '⚔', fadingOut: false },
            EMOJI_LIFETIME_MS
          );
        }
        return;
      }

      if (event.type === 'ROMANCE_EXPRESSED' && event.actorCharacterId) {
        pushEffect(
          { id: event.id, kind: 'emoji', characterId: event.actorCharacterId, emoji: '❤️', fadingOut: false },
          EMOJI_LIFETIME_MS
        );
        return;
      }

      if (event.type === 'CHALLENGE_ISSUED' && event.actorCharacterId) {
        pushEffect(
          { id: event.id, kind: 'emoji', characterId: event.actorCharacterId, emoji: '⚔', fadingOut: false },
          EMOJI_LIFETIME_MS
        );
        return;
      }

      // A conversation ending had no visual at all before this — every
      // other conversation moment (started, each message) already gets
      // one via the speech-bubble branch above.
      if (event.type === 'CONVERSATION_ENDED' && event.actorCharacterId) {
        pushEffect(
          { id: event.id, kind: 'emoji', characterId: event.actorCharacterId, emoji: '🙇', fadingOut: false },
          EMOJI_LIFETIME_MS
        );
        return;
      }

      // FACTION_FOUNDED gets its own banner above; joining an EXISTING
      // faction is quieter — no announcement-worthy banner, just a
      // handshake on the new member (the one actually joining,
      // targetCharacterId — the inviting leader is the actor).
      if (event.type === 'FACTION_MEMBER_JOINED' && event.targetCharacterId) {
        pushEffect(
          { id: event.id, kind: 'emoji', characterId: event.targetCharacterId, emoji: '🤝', fadingOut: false },
          EMOJI_LIFETIME_MS
        );
        return;
      }

      const toastText = toastTextFor(event);
      if (toastText && event.actorCharacterId) {
        pushEffect(
          { id: event.id, kind: 'toast', characterId: event.actorCharacterId, text: toastText, fadingOut: false },
          TOAST_LIFETIME_MS
        );
      }

      // The giver already gets a toast above ("gave away X" / "-N¢") —
      // the recipient side of a gift/transfer had no reaction of their
      // own at all before this.
      if (event.type === 'ITEM_GIVEN' && event.targetCharacterId) {
        pushEffect(
          { id: `${event.id}-received`, kind: 'emoji', characterId: event.targetCharacterId, emoji: '🎁', fadingOut: false },
          EMOJI_LIFETIME_MS
        );
      }
      if (event.type === 'MONEY_TRANSFERRED' && event.targetCharacterId) {
        pushEffect(
          { id: `${event.id}-received`, kind: 'emoji', characterId: event.targetCharacterId, emoji: '🪙', fadingOut: false },
          EMOJI_LIFETIME_MS
        );
      }
    };

    return () => evtSource.close();
  }, [pushEffect]);

  // Clear all outstanding timers on unmount.
  useEffect(() => {
    const timeouts = effectTimeoutsRef.current;
    return () => {
      timeouts.forEach(clearTimeout);
      timeouts.clear();
    };
  }, []);

  if (snapshotError && !snapshot) {
    return (
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-8 text-center text-gray-500 text-sm">
        Couldn&apos;t load the world map — the simulation worker or database may be unavailable.
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-8 text-center text-gray-500 text-sm">
        Loading New Concord…
      </div>
    );
  }

  const locationById = new Map(snapshot.locations.map((loc) => [loc.id, loc]));
  const pointForLocation = (loc: WorldSnapshotLocation): WorldMapPoint => LOCATION_LAYOUT[loc.slug];

  const drawnEdgeKeys = new Set<string>();
  const edges: Array<{ key: string; from: WorldMapPoint; to: WorldMapPoint }> = [];
  for (const loc of snapshot.locations) {
    for (const connectedSlug of loc.connections) {
      const connectedPoint = LOCATION_LAYOUT[connectedSlug];
      if (!connectedPoint) continue;
      const key = [loc.slug, connectedSlug].sort().join('|');
      if (drawnEdgeKeys.has(key)) continue;
      drawnEdgeKeys.add(key);
      edges.push({ key, from: pointForLocation(loc), to: connectedPoint });
    }
  }

  const characterIdsByEffectiveLocationId = new Map<string, string[]>();
  for (const character of snapshot.characters) {
    const effectiveLocationId = locationOverrideByCharacterId[character.id] ?? character.locationId;
    const group = characterIdsByEffectiveLocationId.get(effectiveLocationId) ?? [];
    group.push(character.id);
    characterIdsByEffectiveLocationId.set(effectiveLocationId, group);
  }
  characterIdsByEffectiveLocationId.forEach((group) => group.sort());

  const speechEffectsByCharacterId = new Map(
    effects
      .filter((e): e is Extract<EphemeralEffect, { kind: 'speech' }> => e.kind === 'speech')
      .map((e) => [e.characterId, e])
  );
  const toastEffectsByCharacterId = new Map(
    effects
      .filter((e): e is Extract<EphemeralEffect, { kind: 'toast' }> => e.kind === 'toast')
      .map((e) => [e.characterId, e])
  );
  const emojiEffectsByCharacterId = new Map(
    effects
      .filter((e): e is Extract<EphemeralEffect, { kind: 'emoji' }> => e.kind === 'emoji')
      .map((e) => [e.characterId, e])
  );
  const travelEffects = effects.filter(
    (e): e is Extract<EphemeralEffect, { kind: 'travel' }> => e.kind === 'travel'
  );
  const factionBanner = effects.find(
    (e): e is Extract<EphemeralEffect, { kind: 'faction-banner' }> => e.kind === 'faction-banner'
  );

  // ─── View-mode header ───────────────────────────────────────────────────────
  const header = (
    <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
      <span className="text-sm font-medium">New Concord</span>
      <div className="flex items-center gap-4">
        {/* View toggle */}
        <div className="flex rounded overflow-hidden border border-gray-700 text-xs">
          <button
            onClick={() => setViewMode('world')}
            className={`px-3 py-1 transition-colors ${
              viewMode === 'world'
                ? 'bg-amber-900 text-amber-200'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            🌍 World
          </button>
          <button
            onClick={() => setViewMode('diplomacy')}
            className={`px-3 py-1 transition-colors ${
              viewMode === 'diplomacy'
                ? 'bg-amber-900 text-amber-200'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            ⚑ Diplomacy
          </button>
        </div>
        {/* Status ring legend */}
        <div className="flex items-center gap-3 text-xs text-gray-500">
          {(Object.keys(STATUS_RING_COLOR) as Array<keyof typeof STATUS_RING_COLOR>).map(
            (status) => (
              <span key={status} className="flex items-center gap-1">
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ backgroundColor: STATUS_RING_COLOR[status] }}
                />
                {status}
              </span>
            )
          )}
        </div>
      </div>
    </div>
  );

  if (viewMode === 'diplomacy') {
    return (
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        {header}
        <DiplomacyView />
      </div>
    );
  }

  // ─── World view ─────────────────────────────────────────────────────────────
  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
      {header}

      <svg
        viewBox={`0 0 ${WORLD_MAP_VIEWBOX.width} ${WORLD_MAP_VIEWBOX.height}`}
        className="w-full h-auto"
        role="img"
        aria-label="Map of New Concord with characters shown at their current location"
      >
        <rect width={WORLD_MAP_VIEWBOX.width} height={WORLD_MAP_VIEWBOX.height} fill="#0b0f19" />

        {/* Roads */}
        {edges.map((edge) => (
          <line
            key={edge.key}
            x1={edge.from.x}
            y1={edge.from.y}
            x2={edge.to.x}
            y2={edge.to.y}
            stroke="#293040"
            strokeWidth={2}
          />
        ))}

        {/* Travel pulses */}
        {travelEffects.map((effect) => {
          const from = locationById.get(effect.fromLocationId);
          const to = locationById.get(effect.toLocationId);
          if (!from || !to) return null;
          const fromPoint = LOCATION_LAYOUT[from.slug];
          const toPoint = LOCATION_LAYOUT[to.slug];
          if (!fromPoint || !toPoint) return null;
          return (
            <line
              key={effect.id}
              x1={fromPoint.x}
              y1={fromPoint.y}
              x2={toPoint.x}
              y2={toPoint.y}
              stroke="#7FB2E5"
              strokeWidth={3}
              strokeDasharray="6 6"
              opacity={effect.fadingOut ? 0 : 0.85}
              style={{ transition: `opacity ${FADE_MS}ms ease-out` }}
            />
          );
        })}

        {/* Location nodes — themed SVG icons */}
        {snapshot.locations.map((loc) => {
          const point = pointForLocation(loc);
          return (
            <g key={loc.id}>
              <LocationIcon type={point.type} cx={point.x} cy={point.y} r={24} />
              <text
                x={point.x}
                y={point.y + LOCATION_LABEL_OFFSET_Y}
                textAnchor="middle"
                fill="#8b8f9c"
                fontSize={13}
                fontWeight={600}
                paintOrder="stroke"
                stroke="#0b0f19"
                strokeWidth={4}
              >
                {loc.name}
              </text>
            </g>
          );
        })}

        {/* Characters — each <g> uses CSS transform for smooth position transitions */}
        {snapshot.characters.map((character) => {
          const effectiveLocationId =
            locationOverrideByCharacterId[character.id] ?? character.locationId;
          const location = locationById.get(effectiveLocationId);
          if (!location) return null;
          const basePoint = LOCATION_LAYOUT[location.slug];
          if (!basePoint) return null;
          const group =
            characterIdsByEffectiveLocationId.get(effectiveLocationId) ?? [character.id];
          const offset = characterOffsetWithinLocation(
            group.indexOf(character.id),
            group.length
          );
          const px = basePoint.x + offset.x;
          const py = basePoint.y + offset.y;

          // Name label direction — point outward from the location center so
          // labels don't collide when two characters stand side-by-side.
          // Coordinates are relative to (px, py) since the parent <g> is
          // translated there via CSS transform.
          const isSideOffset = Math.abs(offset.x) > AVATAR_SIZE / 2;
          const relNameX = isSideOffset
            ? Math.sign(offset.x) * (AVATAR_SIZE / 2 + 6)
            : 0;
          const relNameY = isSideOffset ? 4 : AVATAR_SIZE / 2 + 14;
          const nameLabelAnchor: 'start' | 'middle' | 'end' = isSideOffset
            ? offset.x > 0
              ? 'start'
              : 'end'
            : 'middle';

          const speech = speechEffectsByCharacterId.get(character.id);
          const toast = toastEffectsByCharacterId.get(character.id);
          const emoji = emojiEffectsByCharacterId.get(character.id);

          const isIdleOrSleeping =
            character.status === 'idle' || character.status === 'sleeping';

          return (
            // CSS translate for smooth position interpolation between polls.
            // All child elements use coordinates relative to (0, 0) = (px, py).
            <g
              key={character.id}
              style={{
                transform: `translate(${px}px, ${py}px)`,
                transition: 'transform 1.5s ease-in-out',
              }}
              className="cursor-pointer"
            >
              <a href={`/characters/${character.id}`}>
                {/* Faction color outer ring — visible when in a faction */}
                {character.factionColor && (
                  <circle
                    cx={0}
                    cy={0}
                    r={AVATAR_SIZE / 2 + 8}
                    fill={character.factionColor}
                    fillOpacity={0.18}
                    stroke={character.factionColor}
                    strokeWidth={2}
                  />
                )}

                {/* Status ring */}
                <circle
                  cx={0}
                  cy={0}
                  r={AVATAR_SIZE / 2 + 3}
                  fill="none"
                  stroke={STATUS_RING_COLOR[character.status]}
                  strokeWidth={2.5}
                  className={
                    character.status === 'traveling' || character.status === 'conversing'
                      ? 'animate-pulse'
                      : isIdleOrSleeping
                        ? 'animate-[pulse_3s_ease-in-out_infinite]'
                        : undefined
                  }
                />

                {/* Avatar */}
                <g transform={`translate(${-AVATAR_SIZE / 2}, ${-AVATAR_SIZE / 2})`}>
                  <CharacterAvatar
                    seed={character.id}
                    size={AVATAR_SIZE}
                    className="rounded-full"
                  />
                </g>

                {/* Faction rank badge — top-right corner of avatar */}
                {character.factionRank && <RankBadge rank={character.factionRank} />}

                {/* Wealth badge — bottom-right corner of avatar */}
                {character.walletCents >= WEALTHY_WALLET_THRESHOLD_CENTS && <WealthBadge />}

                {/* Name label */}
                <text
                  x={relNameX}
                  y={relNameY}
                  textAnchor={nameLabelAnchor}
                  fill="#c9cdd6"
                  fontSize={11}
                  paintOrder="stroke"
                  stroke="#0b0f19"
                  strokeWidth={3}
                >
                  {character.name}
                </text>
              </a>

              {/* Floating toast (commerce/money events) */}
              {toast && (
                <text
                  x={0}
                  y={-AVATAR_SIZE / 2 - 10}
                  textAnchor="middle"
                  fill="#F2C14E"
                  fontSize={12}
                  fontWeight={700}
                  paintOrder="stroke"
                  stroke="#0b0f19"
                  strokeWidth={3}
                  opacity={toast.fadingOut ? 0 : 1}
                  style={{ transition: `opacity ${FADE_MS}ms ease-out` }}
                >
                  {toast.text}
                </text>
              )}

              {/* Emoji effect — hearts ❤️, swords ⚔, etc. */}
              {emoji && (
                <text
                  x={0}
                  y={-AVATAR_SIZE / 2 - 10}
                  textAnchor="middle"
                  fontSize={16}
                  opacity={emoji.fadingOut ? 0 : 1}
                  style={{ transition: `opacity ${FADE_MS}ms ease-out` }}
                >
                  {emoji.emoji}
                </text>
              )}

              {/* Speech bubble */}
              {speech && (
                <foreignObject
                  x={-90}
                  y={-AVATAR_SIZE / 2 - 68}
                  width={180}
                  height={60}
                  style={{
                    opacity: speech.fadingOut ? 0 : 1,
                    transition: `opacity ${FADE_MS}ms ease-out`,
                  }}
                >
                  <div className="bg-gray-100 text-gray-900 text-[11px] leading-snug rounded-lg px-2 py-1.5 shadow-lg text-center">
                    {speech.text}
                  </div>
                </foreignObject>
              )}
            </g>
          );
        })}

        {/* Faction founding / leadership challenge banner */}
        {factionBanner && (
          <g>
            <rect
              x={40}
              y={20}
              width={WORLD_MAP_VIEWBOX.width - 80}
              height={44}
              rx={6}
              fill="#1a1000"
              stroke="#D97706"
              strokeWidth={1.5}
              opacity={factionBanner.fadingOut ? 0 : 0.95}
              style={{ transition: `opacity ${FADE_MS}ms ease-out` }}
            />
            <text
              x={WORLD_MAP_VIEWBOX.width / 2}
              y={46}
              textAnchor="middle"
              fill="#F2C14E"
              fontSize={14}
              fontWeight={700}
              paintOrder="stroke"
              stroke="#1a1000"
              strokeWidth={2}
              opacity={factionBanner.fadingOut ? 0 : 1}
              style={{ transition: `opacity ${FADE_MS}ms ease-out` }}
            >
              {truncate(factionBanner.text, 100)}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}
