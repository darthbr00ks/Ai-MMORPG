'use client';

import { useEffect, useState } from 'react';
import type {
  DiplomacySnapshot,
  DiplomacyFaction,
  DiplomacyCharacter,
  DiplomacyRelationship,
} from '@/app/api/world/diplomacy/route';
import { CharacterAvatar } from '@/components/CharacterAvatar';
import { RANK_ICON, RANK_ORDER } from '@/lib/faction-constants';

const POLL_MS = 5000;
const CANVAS_W = 1050;
const CANVAS_H = 700;
const CENTER_X = CANVAS_W / 2;
const CENTER_Y = CANVAS_H / 2;
/** Radius of the circle on which faction-bubble centers are placed. */
const FACTION_RING_RADIUS = 260;

/** Map dominant relationship dimension to an edge color. Returns null when the
 * relationship isn't notable enough to draw. */
function edgeColor(rel: DiplomacyRelationship): string | null {
  const { trust, respect, affection, hostility } = rel;
  if (hostility > 15) return '#E74C3C';        // red — hostile
  if (affection > 20) return '#E4A6D6';         // pink — romance
  if (trust > 15 || respect > 15) return '#6FBF9E'; // green — allied/trusted
  if (trust + respect + affection > 8) return '#F2C14E'; // gold — positive
  return null;
}

/** Compute (cx, cy, r) for each faction bubble and (x, y) for every
 * character dot. Called once per render; avoids re-computation inside JSX. */
function computeLayout(factions: DiplomacyFaction[], characters: DiplomacyCharacter[]) {
  const factionPos = new Map<string, { cx: number; cy: number; r: number }>();
  const charPos = new Map<string, { x: number; y: number }>();

  factions.forEach((faction, i) => {
    const members = characters.filter((c) => c.factionId === faction.id);
    const angle =
      factions.length > 0
        ? (i / factions.length) * 2 * Math.PI - Math.PI / 2
        : 0;
    const cx = CENTER_X + FACTION_RING_RADIUS * Math.cos(angle);
    const cy = CENTER_Y + FACTION_RING_RADIUS * Math.sin(angle);
    const r = 64 + Math.min(members.length, 8) * 7;
    factionPos.set(faction.id, { cx, cy, r });

    members.forEach((char, j) => {
      const charAngle = members.length > 1 ? (j / members.length) * 2 * Math.PI : 0;
      const cr = members.length > 1 ? r * 0.52 : 0;
      charPos.set(char.id, {
        x: cx + cr * Math.cos(charAngle),
        y: cy + cr * Math.sin(charAngle),
      });
    });
  });

  // Independent characters — scattered around the center
  const independents = characters.filter((c) => !c.factionId);
  independents.forEach((char, i) => {
    const angle = independents.length > 1 ? (i / independents.length) * 2 * Math.PI : 0;
    const r2 = independents.length > 1 ? 70 : 0;
    charPos.set(char.id, {
      x: CENTER_X + r2 * Math.cos(angle),
      y: CENTER_Y + r2 * Math.sin(angle),
    });
  });

  return { factionPos, charPos };
}

/**
 * Diplomacy View — a political map of alliances, relationships and faction
 * hierarchies.
 *
 * Faction bubbles are placed around a central circle. Characters appear as
 * small avatar dots inside their faction's bubble (or near the centre if
 * independent). Relationship edges are color-coded by the dominant emotion:
 *   🔴 red = hostility   🟢 green = trust/alliance
 *   🩷 pink = romance     🟡 gold  = positive/trade
 *
 * Clicking a faction bubble opens its hierarchy panel on the right.
 */
export default function DiplomacyView() {
  const [snapshot, setSnapshot] = useState<DiplomacySnapshot | null>(null);
  const [error, setError] = useState(false);
  const [selectedFactionId, setSelectedFactionId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch('/api/world/diplomacy');
        if (!res.ok) throw new Error(`diplomacy fetch failed: ${res.status}`);
        const data = (await res.json()) as DiplomacySnapshot;
        if (!cancelled) {
          setSnapshot(data);
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    }
    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (error && !snapshot) {
    return (
      <div className="p-8 text-center text-gray-500 text-sm">
        Couldn&apos;t load diplomacy data — the simulation worker or database may be unavailable.
      </div>
    );
  }
  if (!snapshot) {
    return (
      <div className="p-8 text-center text-gray-500 text-sm">
        Loading diplomacy view…
      </div>
    );
  }

  if (snapshot.factions.length === 0 && snapshot.characters.length === 0) {
    return (
      <div className="p-8 text-center text-gray-500 text-sm">
        No factions have formed yet. Characters are still independent.
      </div>
    );
  }

  const { factionPos, charPos } = computeLayout(snapshot.factions, snapshot.characters);
  const selectedFaction = snapshot.factions.find((f) => f.id === selectedFactionId) ?? null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
        className="w-full h-auto"
        role="img"
        aria-label="Diplomacy view showing factions and relationships"
      >
        <rect width={CANVAS_W} height={CANVAS_H} fill="#0b0f19" />

        {/* No-faction label at centre when there are independents */}
        {snapshot.characters.some((c) => !c.factionId) && (
          <text
            x={CENTER_X}
            y={CENTER_Y - 90}
            textAnchor="middle"
            fill="#4B5563"
            fontSize={11}
          >
            Independent
          </text>
        )}

        {/* Relationship edges — drawn first so they appear behind bubbles */}
        {snapshot.relationships.map((rel) => {
          const a = charPos.get(rel.characterAId);
          const b = charPos.get(rel.characterBId);
          if (!a || !b) return null;
          const color = edgeColor(rel);
          if (!color) return null;
          return (
            <line
              key={`${rel.characterAId}-${rel.characterBId}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={color}
              strokeWidth={1.5}
              opacity={0.35}
            />
          );
        })}

        {/* Faction bubbles */}
        {snapshot.factions.map((faction) => {
          const pos = factionPos.get(faction.id);
          if (!pos) return null;
          const isSelected = selectedFactionId === faction.id;
          return (
            <g
              key={faction.id}
              className="cursor-pointer"
              onClick={() => setSelectedFactionId(isSelected ? null : faction.id)}
            >
              <circle
                cx={pos.cx}
                cy={pos.cy}
                r={pos.r}
                fill={faction.color}
                fillOpacity={isSelected ? 0.18 : 0.08}
                stroke={faction.color}
                strokeWidth={isSelected ? 2.5 : 1.5}
                strokeDasharray={isSelected ? undefined : '6 3'}
              />
              <text
                x={pos.cx}
                y={pos.cy + pos.r + 18}
                textAnchor="middle"
                fill={faction.color}
                fontSize={12}
                fontWeight={700}
                paintOrder="stroke"
                stroke="#0b0f19"
                strokeWidth={3}
              >
                ⚑ {faction.name}
              </text>
            </g>
          );
        })}

        {/* Character dots */}
        {snapshot.characters.map((char) => {
          const pos = charPos.get(char.id);
          if (!pos) return null;
          const faction = char.factionId
            ? snapshot.factions.find((f) => f.id === char.factionId)
            : null;
          const color = faction?.color ?? '#6B7280';
          const rankIcon = char.factionRank ? RANK_ICON[char.factionRank] : '';
          return (
            <g key={char.id}>
              {/* Avatar */}
              <circle cx={pos.x} cy={pos.y} r={14} fill="#1e2535" stroke={color} strokeWidth={1.5} />
              <g transform={`translate(${pos.x - 11}, ${pos.y - 11})`}>
                <CharacterAvatar seed={char.id} size={22} />
              </g>
              {/* Rank badge */}
              {rankIcon && (
                <text
                  x={pos.x + 10}
                  y={pos.y - 10}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={9}
                >
                  {rankIcon}
                </text>
              )}
              {/* Name */}
              <text
                x={pos.x}
                y={pos.y + 22}
                textAnchor="middle"
                fill="#9CA3AF"
                fontSize={9}
                paintOrder="stroke"
                stroke="#0b0f19"
                strokeWidth={2}
              >
                {char.name}
              </text>
            </g>
          );
        })}

        {/* Legend */}
        <g transform="translate(24, 670)">
          {[
            { color: '#E74C3C', label: 'Hostile' },
            { color: '#6FBF9E', label: 'Alliance / Trust' },
            { color: '#E4A6D6', label: 'Romance' },
            { color: '#F2C14E', label: 'Trade / Positive' },
          ].map(({ color, label }, i) => (
            <g key={label} transform={`translate(${i * 130}, 0)`}>
              <line x1={0} y1={7} x2={22} y2={7} stroke={color} strokeWidth={2} />
              <text x={27} y={11} fill="#6B7280" fontSize={10}>
                {label}
              </text>
            </g>
          ))}
        </g>
      </svg>

      {/* Faction hierarchy panel — opens when a faction bubble is clicked */}
      {selectedFaction && (
        <FactionHierarchyPanel
          faction={selectedFaction}
          members={snapshot.characters.filter((c) => c.factionId === selectedFaction.id)}
          onClose={() => setSelectedFactionId(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface FactionHierarchyPanelProps {
  faction: DiplomacyFaction;
  members: DiplomacyCharacter[];
  onClose: () => void;
}

function FactionHierarchyPanel({ faction, members, onClose }: FactionHierarchyPanelProps) {
  const sorted = [...members].sort(
    (a, b) =>
      (RANK_ORDER[a.factionRank ?? 'member'] ?? 4) -
      (RANK_ORDER[b.factionRank ?? 'member'] ?? 4)
  );
  return (
    <div
      className="absolute top-4 right-4 bg-gray-900 border rounded-lg p-4 min-w-[180px] max-w-[260px] text-sm shadow-xl z-10"
      style={{ borderColor: faction.color }}
    >
      <div className="font-bold mb-3" style={{ color: faction.color }}>
        ⚑ {faction.name}
      </div>
      <div className="space-y-1.5 text-gray-300 text-xs">
        {sorted.map((member, i) => (
          <div key={member.id} className="flex items-center gap-2">
            <span className="text-gray-600 w-3">{i > 0 ? '↳' : ''}</span>
            <span>
              {member.factionRank ? RANK_ICON[member.factionRank] : ''}{' '}
              {member.name}
            </span>
          </div>
        ))}
        {sorted.length === 0 && (
          <p className="text-gray-500 italic">No members yet.</p>
        )}
      </div>
      <button
        onClick={onClose}
        className="mt-3 text-xs text-gray-500 hover:text-gray-300"
      >
        Close ×
      </button>
    </div>
  );
}
