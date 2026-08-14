'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CharacterAvatar } from '@/components/CharacterAvatar';
import {
  LOCATION_LAYOUT,
  WORLD_MAP_VIEWBOX,
  characterOffsetWithinLocation,
  type WorldMapPoint,
} from '@/lib/world-layout';
import type { WorldSnapshot, WorldSnapshotCharacter, WorldSnapshotLocation } from '@/app/api/world/snapshot/route';

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
  | {
      id: string;
      kind: 'travel';
      fromLocationId: string;
      toLocationId: string;
      fadingOut: boolean;
    };

const SPEECH_LIFETIME_MS = 5000;
const TOAST_LIFETIME_MS = 2200;
const TRAVEL_PULSE_LIFETIME_MS = 3500;
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

/**
 * Live top-down view of New Concord — location nodes wired up per the
 * seeded connections graph, character avatars standing at their current
 * location, moving as they move, with speech bubbles and floating
 * effects for what's happening right now. This is the "watch it like a
 * world, not a log" view: /spectate's EventFeed is still the accurate
 * detailed record, this is the at-a-glance one.
 *
 * Two independent data sources, deliberately not merged into one:
 *  - /api/world/snapshot, polled every SNAPSHOT_POLL_MS — authoritative
 *    who's-where-and-doing-what. Self-healing: a missed poll just means
 *    a stale render for a few seconds, corrected by the next one.
 *  - /api/events/stream (SSE, already existed) — layered on top purely
 *    for transient effects (speech bubbles, travel pulses, toasts). A
 *    dropped event here just means one fewer animation, never a wrong
 *    position, because position never depends on the event stream.
 */
export default function WorldMap() {
  const [snapshot, setSnapshot] = useState<WorldSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState(false);
  // Optimistic location overrides applied immediately from CHARACTER_MOVED
  // events, so movement reads as live rather than waiting up to
  // SNAPSHOT_POLL_MS for the next poll. The next snapshot always wins —
  // this is purely a between-polls smoothing layer, never trusted alone.
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
          // A fresh authoritative snapshot always supersedes any
          // between-poll optimistic overrides for the characters it covers.
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
  // for the transient visuals described in the class doc comment.
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
        // Optimistic move — see the state doc comment above.
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

      const toastText = toastTextFor(event);
      if (toastText && event.actorCharacterId) {
        pushEffect(
          { id: event.id, kind: 'toast', characterId: event.actorCharacterId, text: toastText, fadingOut: false },
          TOAST_LIFETIME_MS
        );
      }
    };

    return () => evtSource.close();
  }, [pushEffect]);

  // Timers are owned by this component's lifetime, not any one effect's —
  // clear everything outstanding on unmount so a slow-to-fire setTimeout
  // never calls setState after WorldMap is gone.
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

  // Each connection is listed on (at least) one side of the pair — de-dupe
  // by a sorted key so a bidirectional pair isn't drawn twice.
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

  // Grouped by *effective* location (optimistic override applied) so a
  // character mid-fan-out doesn't jump slots the instant a MOVE event
  // updates their override — the whole point of characterOffsetWithinLocation
  // needing count+index is to keep everyone at a hub visually separated,
  // which requires computing groups here, not per-character in isolation.
  // Sorted by id for a stable slot assignment across polls (see that
  // function's doc comment).
  const characterIdsByEffectiveLocationId = new Map<string, string[]>();
  for (const character of snapshot.characters) {
    const effectiveLocationId = locationOverrideByCharacterId[character.id] ?? character.locationId;
    const group = characterIdsByEffectiveLocationId.get(effectiveLocationId) ?? [];
    group.push(character.id);
    characterIdsByEffectiveLocationId.set(effectiveLocationId, group);
  }
  characterIdsByEffectiveLocationId.forEach((group) => group.sort());

  const speechEffectsByCharacterId = new Map(
    effects.filter((e): e is Extract<EphemeralEffect, { kind: 'speech' }> => e.kind === 'speech').map((e) => [e.characterId, e])
  );
  const toastEffectsByCharacterId = new Map(
    effects.filter((e): e is Extract<EphemeralEffect, { kind: 'toast' }> => e.kind === 'toast').map((e) => [e.characterId, e])
  );
  const travelEffects = effects.filter((e): e is Extract<EphemeralEffect, { kind: 'travel' }> => e.kind === 'travel');

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
        <span className="text-sm font-medium">New Concord</span>
        <div className="flex items-center gap-3 text-xs text-gray-500">
          {(Object.keys(STATUS_RING_COLOR) as Array<keyof typeof STATUS_RING_COLOR>).map((status) => (
            <span key={status} className="flex items-center gap-1">
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ backgroundColor: STATUS_RING_COLOR[status] }}
              />
              {status}
            </span>
          ))}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${WORLD_MAP_VIEWBOX.width} ${WORLD_MAP_VIEWBOX.height}`}
        className="w-full h-auto"
        role="img"
        aria-label="Map of New Concord with characters shown at their current location"
      >
        <rect width={WORLD_MAP_VIEWBOX.width} height={WORLD_MAP_VIEWBOX.height} fill="#0b0f19" />

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

        {snapshot.locations.map((loc) => {
          const point = pointForLocation(loc);
          return (
            <g key={loc.id}>
              <circle cx={point.x} cy={point.y} r={24} fill="#161b28" stroke="#3a2f1f" strokeWidth={1.5} />
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

        {snapshot.characters.map((character) => {
          const effectiveLocationId = locationOverrideByCharacterId[character.id] ?? character.locationId;
          const location = locationById.get(effectiveLocationId);
          if (!location) return null;
          const basePoint = LOCATION_LAYOUT[location.slug];
          if (!basePoint) return null;
          const group = characterIdsByEffectiveLocationId.get(effectiveLocationId) ?? [character.id];
          const offset = characterOffsetWithinLocation(group.indexOf(character.id), group.length);
          const px = basePoint.x + offset.x;
          const py = basePoint.y + offset.y;

          // A name label centered under every avatar collides with its
          // neighbors' labels the moment two characters land side by
          // side in the ring above — pointing the label outward (away
          // from the location center, like a map pin tag) instead gives
          // each one its own lane. Near-vertical offsets (top/bottom of
          // the ring) keep the simpler centered-below placement, where
          // there's no horizontal neighbor to collide with.
          const isSideOffset = Math.abs(offset.x) > AVATAR_SIZE / 2;
          const nameLabelX = isSideOffset ? px + Math.sign(offset.x) * (AVATAR_SIZE / 2 + 6) : px;
          const nameLabelY = isSideOffset ? py + 4 : py + AVATAR_SIZE / 2 + 14;
          const nameLabelAnchor: 'start' | 'middle' | 'end' = isSideOffset
            ? offset.x > 0
              ? 'start'
              : 'end'
            : 'middle';

          const speech = speechEffectsByCharacterId.get(character.id);
          const toast = toastEffectsByCharacterId.get(character.id);

          return (
            <g key={character.id} className="cursor-pointer">
              <a href={`/characters/${character.id}`}>
                <circle
                  cx={px}
                  cy={py}
                  r={AVATAR_SIZE / 2 + 3}
                  fill="none"
                  stroke={STATUS_RING_COLOR[character.status]}
                  strokeWidth={2.5}
                  className={character.status === 'traveling' || character.status === 'conversing' ? 'animate-pulse' : undefined}
                />
                <g transform={`translate(${px - AVATAR_SIZE / 2}, ${py - AVATAR_SIZE / 2})`}>
                  <CharacterAvatar seed={character.id} size={AVATAR_SIZE} className="rounded-full" />
                </g>
                <text
                  x={nameLabelX}
                  y={nameLabelY}
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

              {toast && (
                <text
                  x={px}
                  y={py - AVATAR_SIZE / 2 - 10}
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

              {speech && (
                <foreignObject
                  x={px - 90}
                  y={py - AVATAR_SIZE / 2 - 68}
                  width={180}
                  height={60}
                  style={{ opacity: speech.fadingOut ? 0 : 1, transition: `opacity ${FADE_MS}ms ease-out` }}
                >
                  <div className="bg-gray-100 text-gray-900 text-[11px] leading-snug rounded-lg px-2 py-1.5 shadow-lg text-center">
                    {speech.text}
                  </div>
                </foreignObject>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
