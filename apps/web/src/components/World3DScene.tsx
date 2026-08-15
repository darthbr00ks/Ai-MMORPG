'use client';

import { Canvas, useFrame } from '@react-three/fiber';
import { Html, OrbitControls } from '@react-three/drei';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { WorldSnapshot, WorldSnapshotCharacter } from '@/app/api/world/snapshot/route';
import {
  LOCATION_SCENE_LAYOUT,
  ROAD_SEGMENTS,
  WORLD_TILE_SIZE,
  buildWorldTiles,
  findWorldPath,
  getConversationMeetingSpots,
  getLocationCharacterSpot,
  type SceneLocationLayout,
  type WorldPoint,
} from '@/lib/world-scene-layout';
import { useWorldEvents, type WorldStreamEvent } from '@/lib/use-world-events';

type TravelPlan = {
  characterId: string;
  fromLocationId: string;
  toLocationId: string;
  startedAtMs: number;
  etaMs: number;
};

type ConversationStage = {
  id: string;
  participantAId: string;
  participantBId: string;
  locationId: string | null;
  updatedAtMs: number;
  endedAtMs: number | null;
};

type SpeechBubble = {
  id: string;
  characterId: string;
  text: string;
  expiresAtMs: number;
};

type RenderCharacter = WorldSnapshotCharacter & {
  locationSlug: string;
  targetPosition: WorldPoint;
  facingTarget?: WorldPoint;
  isTalking: boolean;
  speechText?: string;
  hovered: boolean;
  selected: boolean;
};

const SPEECH_LIFETIME_MS = 5000;
const CONVERSATION_STAGE_GRACE_MS = 3500;

const FUR_PALETTE = [
  '#6f4b33',
  '#8d6242',
  '#c6a27f',
  '#4f3629',
  '#e3d5bf',
  '#8b6a53',
] as const;

const TUNIC_PALETTE = [
  '#3c7a5d',
  '#385b8a',
  '#8a5a3b',
  '#6a497d',
  '#8a3b4b',
  '#7b7a37',
] as const;

function hashString(input: string) {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function lerpPoint(a: WorldPoint, b: WorldPoint, t: number): WorldPoint {
  return {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

function pathPointAtProgress(path: WorldPoint[], progress: number) {
  if (path.length <= 1) {
    return path[0] ?? { x: 0, z: 0 };
  }
  const segmentLengths: number[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const length = Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
    segmentLengths.push(length);
    total += length;
  }
  if (total === 0) {
    return path[path.length - 1];
  }
  let distance = total * progress;
  for (let i = 0; i < segmentLengths.length; i++) {
    if (distance <= segmentLengths[i]) {
      const local = segmentLengths[i] === 0 ? 1 : distance / segmentLengths[i];
      return lerpPoint(path[i], path[i + 1], local);
    }
    distance -= segmentLengths[i];
  }
  return path[path.length - 1];
}

function statusLabel(character: WorldSnapshotCharacter) {
  switch (character.status) {
    case 'traveling':
      return 'Walking the roads';
    case 'conversing':
      return 'In conversation';
    case 'working':
      return 'At work';
    case 'planning':
      return 'Plotting';
    case 'sleeping':
      return 'Sleeping';
    case 'idle':
    default:
      return 'Loitering';
  }
}

function CharacterInspector({
  character,
}: {
  character: WorldSnapshotCharacter | undefined;
}) {
  if (!character) {
    return (
      <div className="w-72 border-l border-gray-800 bg-gray-950/95 p-4 text-sm text-gray-400">
        <div className="text-base font-semibold text-gray-200">Selection</div>
        <p className="mt-3">Click a bear to inspect their role, faction, wealth, and current activity.</p>
      </div>
    );
  }

  return (
    <div className="w-72 border-l border-gray-800 bg-gray-950/95 p-4 text-sm text-gray-200">
      <div className="text-xs uppercase tracking-[0.25em] text-amber-400">Selected Character</div>
      <h3 className="mt-2 text-xl font-semibold">{character.name}</h3>
      <p className="text-gray-400">{character.archetype}</p>

      <dl className="mt-4 space-y-3">
        <div>
          <dt className="text-xs uppercase tracking-wide text-gray-500">Age</dt>
          <dd>{character.age}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-gray-500">Current Activity</dt>
          <dd>{statusLabel(character)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-gray-500">Location</dt>
          <dd>{character.locationName}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-gray-500">Faction</dt>
          <dd>{character.factionName ?? 'Unaffiliated'}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-gray-500">Rank</dt>
          <dd className="capitalize">{character.factionRank ?? 'None'}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-gray-500">Wealth</dt>
          <dd>{(character.walletCents / 100).toFixed(2)} coins</dd>
        </div>
      </dl>
    </div>
  );
}

function Road({ start, end }: { start: WorldPoint; end: WorldPoint }) {
  const midpoint = useMemo(
    () => new THREE.Vector3((start.x + end.x) / 2, 0.02, (start.z + end.z) / 2),
    [end.x, end.z, start.x, start.z]
  );
  const length = Math.hypot(end.x - start.x, end.z - start.z);
  const angle = Math.atan2(end.z - start.z, end.x - start.x);
  return (
    <mesh position={midpoint} rotation={[-Math.PI / 2, 0, angle]}>
      <planeGeometry args={[length, 2.6]} />
      <meshStandardMaterial color="#8b7a5e" />
    </mesh>
  );
}

function Building({ layout }: { layout: SceneLocationLayout }) {
  const { buildingCenter, type } = layout;
  if (type === 'town-square') {
    return (
      <mesh position={[buildingCenter.x, 0.01, buildingCenter.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[12, 12]} />
        <meshStandardMaterial color="#6f7681" />
      </mesh>
    );
  }

  if (type === 'market') {
    return (
      <group position={[buildingCenter.x, 0, buildingCenter.z]}>
        {[-2.4, 0, 2.4].map((offset) => (
          <group key={offset} position={[offset, 0, 0]}>
            <mesh position={[0, 1.1, 0]}>
              <boxGeometry args={[2.2, 2.2, 2]} />
              <meshStandardMaterial color="#a07855" />
            </mesh>
            <mesh position={[0, 2.5, 0]}>
              <coneGeometry args={[1.8, 1.4, 4]} />
              <meshStandardMaterial color="#b14e3d" />
            </mesh>
          </group>
        ))}
      </group>
    );
  }

  if (type === 'farm') {
    return (
      <group position={[buildingCenter.x, 0, buildingCenter.z]}>
        <mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[12, 10]} />
          <meshStandardMaterial color="#8f6d3a" />
        </mesh>
        {[-4, -2, 0, 2, 4].map((row) => (
          <mesh key={row} position={[row, 0.1, -0.5]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[0.6, 8]} />
            <meshStandardMaterial color="#c9b24c" />
          </mesh>
        ))}
        <mesh position={[3.5, 1.8, -3]}>
          <boxGeometry args={[4, 3.6, 4]} />
          <meshStandardMaterial color="#b78b63" />
        </mesh>
        <mesh position={[3.5, 4.1, -3]} rotation={[0, Math.PI / 4, 0]}>
          <coneGeometry args={[3.3, 2.4, 4]} />
          <meshStandardMaterial color="#8a533b" />
        </mesh>
      </group>
    );
  }

  if (type === 'mine') {
    return (
      <group position={[buildingCenter.x, 0, buildingCenter.z]}>
        <mesh position={[0, 1.5, 0]}>
          <boxGeometry args={[8, 3, 5]} />
          <meshStandardMaterial color="#4f545e" />
        </mesh>
        <mesh position={[0, 0.8, 2.4]}>
          <boxGeometry args={[2.5, 1.6, 1]} />
          <meshStandardMaterial color="#1f232b" />
        </mesh>
      </group>
    );
  }

  return (
    <group position={[buildingCenter.x, 0, buildingCenter.z]}>
      <mesh position={[0, 1.75, 0]}>
        <boxGeometry args={[layout.footprint?.width ?? 6, 3.5, layout.footprint?.depth ?? 5]} />
        <meshStandardMaterial
          color={
            type === 'city-hall'
              ? '#908d88'
              : type === 'warehouse'
                ? '#7a5f47'
                : type === 'bank'
                  ? '#8d8674'
                  : type === 'guard-station'
                    ? '#5c6778'
                    : '#b78b63'
          }
        />
      </mesh>
      <mesh position={[0, 4.35, 0]} rotation={[0, Math.PI / 4, 0]}>
        <coneGeometry args={[(layout.footprint?.width ?? 6) * 0.78, 2.5, 4]} />
        <meshStandardMaterial color={type === 'guard-station' ? '#35517f' : '#7b4536'} />
      </mesh>
    </group>
  );
}

function TerrainDecor() {
  const tiles = useMemo(() => buildWorldTiles().filter((tile) => tile.terrain !== 'grass'), []);
  return (
    <group>
      {tiles.map((tile) => {
        const point = {
          x: tile.x * WORLD_TILE_SIZE,
          z: tile.y * WORLD_TILE_SIZE,
        };
        return (
          <mesh
            key={`${tile.x},${tile.y}`}
            position={[point.x, 0.005, point.z]}
            rotation={[-Math.PI / 2, 0, 0]}
          >
            <planeGeometry args={[WORLD_TILE_SIZE, WORLD_TILE_SIZE]} />
            <meshStandardMaterial
              color={
                tile.terrain === 'stone'
                  ? '#707682'
                  : tile.terrain === 'road'
                    ? '#8b7a5e'
                    : '#8f6d3a'
              }
            />
          </mesh>
        );
      })}
      {[-1, 1].map((side) => (
        <group key={side} position={[24, 0, 17]}>
          {[-5, -2.5, 0, 2.5, 5].map((offset) => (
            <mesh key={offset} position={[offset, 0.9, side * 5.3]}>
              <boxGeometry args={[0.2, 1.8, 0.2]} />
              <meshStandardMaterial color="#8a6a42" />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

function CharacterActor({
  character,
  onSelect,
}: {
  character: RenderCharacter;
  onSelect: (characterId: string) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const headRef = useRef<THREE.Group>(null);
  const leftArmRef = useRef<THREE.Mesh>(null);
  const rightArmRef = useRef<THREE.Mesh>(null);
  const leftLegRef = useRef<THREE.Mesh>(null);
  const rightLegRef = useRef<THREE.Mesh>(null);
  const currentPosition = useRef(
    new THREE.Vector3(character.targetPosition.x, 0, character.targetPosition.z)
  );
  const velocity = useRef(new THREE.Vector3());
  const desired = useMemo(
    () => new THREE.Vector3(character.targetPosition.x, 0, character.targetPosition.z),
    [character.targetPosition.x, character.targetPosition.z]
  );
  const appearance = useMemo(() => {
    const hash = hashString(character.id);
    return {
      fur: FUR_PALETTE[hash % FUR_PALETTE.length],
      tunic: TUNIC_PALETTE[Math.floor(hash / FUR_PALETTE.length) % TUNIC_PALETTE.length],
      accent: character.factionColor ?? '#d7c9ae',
    };
  }, [character.factionColor, character.id]);

  useFrame((state, delta) => {
    const motion = desired.clone().sub(currentPosition.current);
    const distance = motion.length();
    const isMoving = distance > 0.12;
    const moveSpeed = isMoving ? 6.4 : 4.2;
    if (distance > 0.01) {
      motion.normalize();
      const step = Math.min(distance, moveSpeed * delta);
      velocity.current.copy(motion).multiplyScalar(step / Math.max(delta, 0.001));
      currentPosition.current.addScaledVector(motion, step);
    } else {
      velocity.current.multiplyScalar(0);
      currentPosition.current.lerp(desired, 0.25);
    }

    if (groupRef.current) {
      groupRef.current.position.copy(currentPosition.current);
      const lookTarget = character.facingTarget
        ? new THREE.Vector3(character.facingTarget.x, 0, character.facingTarget.z)
        : currentPosition.current.clone().add(velocity.current);
      if (lookTarget.distanceTo(currentPosition.current) > 0.02) {
        const yaw = Math.atan2(
          lookTarget.x - currentPosition.current.x,
          lookTarget.z - currentPosition.current.z
        );
        groupRef.current.rotation.y = THREE.MathUtils.lerp(
          groupRef.current.rotation.y,
          yaw,
          0.18
        );
      }
    }

    const t = state.clock.getElapsedTime();
    const walkCycle = Math.sin(t * 8);
    const idleCycle = Math.sin(t * 2 + hashString(character.id) * 0.01);
    const gait = isMoving ? walkCycle * 0.65 : 0;
    const talkGesture = character.isTalking ? Math.sin(t * 5) * 0.4 : 0;

    if (headRef.current) {
      headRef.current.position.y = 2.65 + (isMoving ? 0.05 : 0.08) * idleCycle;
    }
    if (leftArmRef.current) {
      leftArmRef.current.rotation.x = -gait + talkGesture;
    }
    if (rightArmRef.current) {
      rightArmRef.current.rotation.x = gait - talkGesture * 0.5;
    }
    if (leftLegRef.current) {
      leftLegRef.current.rotation.x = gait;
    }
    if (rightLegRef.current) {
      rightLegRef.current.rotation.x = -gait;
    }
  });

  return (
    <group
      ref={groupRef}
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect(character.id);
      }}
    >
      {character.selected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
          <ringGeometry args={[0.95, 1.18, 32]} />
          <meshBasicMaterial color="#f2c14e" transparent opacity={0.95} />
        </mesh>
      )}
      <mesh position={[0, 1.4, 0]}>
        <boxGeometry args={[0.95, 1.3, 0.6]} />
        <meshStandardMaterial color={appearance.tunic} />
      </mesh>
      <mesh position={[0, 1.9, 0.32]}>
        <boxGeometry args={[0.72, 0.7, 0.2]} />
        <meshStandardMaterial color={appearance.accent} />
      </mesh>
      <group ref={headRef} position={[0, 2.65, 0]}>
        <mesh>
          <sphereGeometry args={[0.52, 14, 12]} />
          <meshStandardMaterial color={appearance.fur} />
        </mesh>
        <mesh position={[-0.28, 0.32, -0.06]}>
          <sphereGeometry args={[0.16, 10, 10]} />
          <meshStandardMaterial color={appearance.fur} />
        </mesh>
        <mesh position={[0.28, 0.32, -0.06]}>
          <sphereGeometry args={[0.16, 10, 10]} />
          <meshStandardMaterial color={appearance.fur} />
        </mesh>
        <mesh position={[0, -0.05, 0.42]}>
          <sphereGeometry args={[0.2, 12, 12]} />
          <meshStandardMaterial color="#e8d8c4" />
        </mesh>
        <mesh position={[0, 0.03, 0.6]}>
          <sphereGeometry args={[0.06, 10, 10]} />
          <meshStandardMaterial color="#2d251f" />
        </mesh>
      </group>
      <mesh ref={leftArmRef} position={[-0.68, 1.55, 0]}>
        <boxGeometry args={[0.24, 1.05, 0.24]} />
        <meshStandardMaterial color={appearance.fur} />
      </mesh>
      <mesh ref={rightArmRef} position={[0.68, 1.55, 0]}>
        <boxGeometry args={[0.24, 1.05, 0.24]} />
        <meshStandardMaterial color={appearance.fur} />
      </mesh>
      <mesh ref={leftLegRef} position={[-0.22, 0.55, 0]}>
        <boxGeometry args={[0.28, 1.1, 0.28]} />
        <meshStandardMaterial color={appearance.fur} />
      </mesh>
      <mesh ref={rightLegRef} position={[0.22, 0.55, 0]}>
        <boxGeometry args={[0.28, 1.1, 0.28]} />
        <meshStandardMaterial color={appearance.fur} />
      </mesh>
      <mesh position={[-0.22, 0.02, 0.12]}>
        <boxGeometry args={[0.34, 0.12, 0.56]} />
        <meshStandardMaterial color="#4f4033" />
      </mesh>
      <mesh position={[0.22, 0.02, 0.12]}>
        <boxGeometry args={[0.34, 0.12, 0.56]} />
        <meshStandardMaterial color="#4f4033" />
      </mesh>

      <Html position={[0, 3.5, 0]} center distanceFactor={18}>
        <div className="rounded bg-gray-950/85 px-2 py-1 text-[10px] font-medium text-gray-100 shadow-lg whitespace-nowrap">
          {character.name}
        </div>
      </Html>

      {character.hovered && !character.speechText && (
        <Html position={[0, 4.15, 0]} center distanceFactor={18}>
          <div className="rounded bg-amber-950/85 px-2 py-1 text-[10px] text-amber-100 shadow-lg whitespace-nowrap">
            {character.factionName
              ? `${character.factionName}${character.factionRank ? ` · ${character.factionRank}` : ''}`
              : statusLabel(character)}
          </div>
        </Html>
      )}

      {character.speechText && (
        <Html position={[0, 4.45, 0]} center distanceFactor={15}>
          <div className="max-w-[180px] rounded-xl bg-gray-100 px-3 py-2 text-center text-xs leading-snug text-gray-900 shadow-xl">
            {character.speechText}
          </div>
        </Html>
      )}
    </group>
  );
}

function Scene({
  characters,
  onSelectCharacter,
  hoveredCharacterId,
  onHoverCharacter,
}: {
  characters: RenderCharacter[];
  onSelectCharacter: (characterId: string | null) => void;
  hoveredCharacterId: string | null;
  onHoverCharacter: (characterId: string | null) => void;
}) {
  return (
    <>
      <color attach="background" args={['#90b7db']} />
      <fog attach="fog" args={['#90b7db', 30, 75]} />
      <ambientLight intensity={1.1} />
      <directionalLight position={[18, 24, 10]} intensity={1.7} castShadow />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow>
        <planeGeometry args={[90, 90]} />
        <meshStandardMaterial color="#6d9857" />
      </mesh>

      <TerrainDecor />

      {ROAD_SEGMENTS.map(([fromSlug, toSlug]) => (
        <Road
          key={`${fromSlug}-${toSlug}`}
          start={LOCATION_SCENE_LAYOUT[fromSlug].characterAnchor}
          end={LOCATION_SCENE_LAYOUT[toSlug].characterAnchor}
        />
      ))}

      {Object.entries(LOCATION_SCENE_LAYOUT).map(([slug, layout]) => (
        <group key={slug}>
          <Building layout={layout} />
          <Html
            position={[layout.characterAnchor.x, 0.15, layout.characterAnchor.z]}
            center
            distanceFactor={22}
          >
            <div className="rounded bg-black/45 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-gray-100 whitespace-nowrap">
              {layout.label}
            </div>
          </Html>
        </group>
      ))}

      {characters.map((character) => (
        <group
          key={character.id}
          onPointerOver={(event) => {
            event.stopPropagation();
            onHoverCharacter(character.id);
          }}
          onPointerOut={(event) => {
            event.stopPropagation();
            onHoverCharacter(null);
          }}
        >
          <CharacterActor
            character={{
              ...character,
              hovered: hoveredCharacterId === character.id,
              selected: character.selected,
            }}
            onSelect={onSelectCharacter}
          />
        </group>
      ))}

      <OrbitControls
        makeDefault
        target={[4, 0, 0]}
        minDistance={18}
        maxDistance={46}
        maxPolarAngle={Math.PI / 2.25}
        minPolarAngle={Math.PI / 3.2}
      />
    </>
  );
}

export default function World3DScene({ snapshot }: { snapshot: WorldSnapshot }) {
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  const [hoveredCharacterId, setHoveredCharacterId] = useState<string | null>(null);
  const [travelPlans, setTravelPlans] = useState<Record<string, TravelPlan>>({});
  const [conversations, setConversations] = useState<Record<string, ConversationStage>>({});
  const [speechBubbles, setSpeechBubbles] = useState<Record<string, SpeechBubble>>({});

  useEffect(() => {
    setSelectedCharacterId((current) =>
      current && snapshot.characters.some((character) => character.id === current)
        ? current
        : snapshot.characters[0]?.id ?? null
    );
  }, [snapshot.characters]);

  useEffect(() => {
    const now = Date.now();
    setTravelPlans((current) => {
      const next = { ...current };
      for (const character of snapshot.characters) {
        if (
          character.status === 'traveling' &&
          character.travelDestinationId &&
          character.travelEta
        ) {
          next[character.id] ??= {
            characterId: character.id,
            fromLocationId: character.locationId,
            toLocationId: character.travelDestinationId,
            startedAtMs: now,
            etaMs: new Date(character.travelEta).getTime(),
          };
        } else {
          delete next[character.id];
        }
      }
      return next;
    });
  }, [snapshot.characters]);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setSpeechBubbles((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([, bubble]) => bubble.expiresAtMs > now)
        )
      );
      setConversations((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([, stage]) => {
            if (stage.endedAtMs === null) return true;
            return stage.endedAtMs + CONVERSATION_STAGE_GRACE_MS > now;
          })
        )
      );
      setTravelPlans((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([, plan]) => plan.etaMs > now - 250)
        )
      );
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const handleEvent = useCallback((event: WorldStreamEvent) => {
    const now = Date.now();
    if (
      event.type === 'CHARACTER_MOVED' &&
      event.actorCharacterId &&
      event.locationId &&
      typeof event.payload.destination_id === 'string' &&
      typeof event.payload.eta === 'string'
    ) {
      setTravelPlans((current) => ({
        ...current,
        [event.actorCharacterId as string]: {
          characterId: event.actorCharacterId as string,
          fromLocationId: event.locationId as string,
          toLocationId: event.payload.destination_id as string,
          startedAtMs: now,
          etaMs: new Date(event.payload.eta as string).getTime(),
        },
      }));
      return;
    }

    if (
      event.type === 'CONVERSATION_STARTED' ||
      event.type === 'CONVERSATION_MESSAGE'
    ) {
      if (
        event.actorCharacterId &&
        event.targetCharacterId &&
        typeof event.payload.message === 'string'
      ) {
        const actorCharacterId = event.actorCharacterId;
        const [participantAId, participantBId] = [
          actorCharacterId,
          event.targetCharacterId,
        ].sort();
        const stageId = `${participantAId}|${participantBId}`;
        setConversations((current) => ({
          ...current,
          [stageId]: {
            id: stageId,
            participantAId,
            participantBId,
            locationId: event.locationId,
            updatedAtMs: now,
            endedAtMs: null,
          },
        }));
        setSpeechBubbles((current) => ({
          ...current,
          [actorCharacterId]: {
            id: event.id,
            characterId: actorCharacterId,
            text: event.payload.message as string,
            expiresAtMs: now + SPEECH_LIFETIME_MS,
          },
        }));
      }
      return;
    }

    if (
      event.type === 'CONVERSATION_ENDED' &&
      event.actorCharacterId &&
      event.targetCharacterId
    ) {
      const [participantAId, participantBId] = [
        event.actorCharacterId,
        event.targetCharacterId,
      ].sort();
      const stageId = `${participantAId}|${participantBId}`;
      setConversations((current) =>
        current[stageId]
          ? {
              ...current,
              [stageId]: {
                ...current[stageId],
                updatedAtMs: now,
                endedAtMs: now,
              },
            }
          : current
      );
    }
  }, []);

  useWorldEvents(handleEvent);

  const renderCharacters = useMemo<RenderCharacter[]>(() => {
    const locationById = new Map(snapshot.locations.map((location) => [location.id, location]));
    const now = Date.now();
    const activeConversationByCharacterId = new Map<
      string,
      { stage: ConversationStage; target: WorldPoint; facing: WorldPoint }
    >();

    for (const stage of Object.values(conversations)) {
      if (!stage.locationId) continue;
      const location = locationById.get(stage.locationId);
      if (!location) continue;
      const spots = getConversationMeetingSpots(
        location.slug,
        stage.participantAId,
        stage.participantBId
      );
      activeConversationByCharacterId.set(stage.participantAId, {
        stage,
        target: spots.a,
        facing: spots.b,
      });
      activeConversationByCharacterId.set(stage.participantBId, {
        stage,
        target: spots.b,
        facing: spots.a,
      });
    }

    const characterIdsByLocationId = new Map<string, string[]>();
    for (const character of snapshot.characters) {
      const group = characterIdsByLocationId.get(character.locationId) ?? [];
      group.push(character.id);
      characterIdsByLocationId.set(character.locationId, group);
    }
    characterIdsByLocationId.forEach((group) => group.sort());

    return snapshot.characters.map((character) => {
      const location = locationById.get(character.locationId);
      const locationSlug = location?.slug ?? 'town-square';
      const locationGroup = characterIdsByLocationId.get(character.locationId) ?? [character.id];
      const anchor = getLocationCharacterSpot(
        locationSlug,
        locationGroup.indexOf(character.id),
        locationGroup.length
      );
      const activeConversation = activeConversationByCharacterId.get(character.id);
      const travelPlan = travelPlans[character.id];
      let targetPosition = anchor;
      let facingTarget: WorldPoint | undefined;

      if (travelPlan) {
        const fromSlug = locationById.get(travelPlan.fromLocationId)?.slug;
        const toSlug = locationById.get(travelPlan.toLocationId)?.slug;
        if (fromSlug && toSlug) {
          const fromAnchor = LOCATION_SCENE_LAYOUT[fromSlug]?.characterAnchor;
          const toAnchor = LOCATION_SCENE_LAYOUT[toSlug]?.characterAnchor;
          if (fromAnchor && toAnchor) {
            const path = findWorldPath(fromAnchor, toAnchor);
            const progress = THREE.MathUtils.clamp(
              (now - travelPlan.startedAtMs) /
                Math.max(travelPlan.etaMs - travelPlan.startedAtMs, 1),
              0,
              1
            );
            targetPosition = pathPointAtProgress(path, progress);
            const lookAhead = pathPointAtProgress(path, Math.min(1, progress + 0.02));
            facingTarget = lookAhead;
          }
        }
      } else if (activeConversation) {
        targetPosition = activeConversation.target;
        facingTarget = activeConversation.facing;
      }

      const speechText = speechBubbles[character.id]?.text;

      return {
        ...character,
        locationSlug,
        targetPosition,
        facingTarget,
        isTalking: Boolean(speechText || activeConversation),
        speechText,
        hovered: hoveredCharacterId === character.id,
        selected: selectedCharacterId === character.id,
      };
    });
  }, [
    conversations,
    hoveredCharacterId,
    selectedCharacterId,
    snapshot.characters,
    snapshot.locations,
    speechBubbles,
    travelPlans,
  ]);

  const selectedCharacter = snapshot.characters.find(
    (character) => character.id === selectedCharacterId
  );

  return (
    <div className="flex h-[720px]">
      <div className="relative flex-1">
        <div className="absolute left-4 top-4 z-10 max-w-sm rounded-lg border border-gray-800 bg-gray-950/90 px-4 py-3 text-xs text-gray-300 backdrop-blur">
          <div className="font-semibold text-amber-400">Living World View</div>
          <p className="mt-1 text-gray-400">
            Bears walk roads, cluster at locations, and physically step together when conversations happen.
          </p>
        </div>

        <Canvas
          camera={{ position: [20, 24, 24], fov: 42 }}
          onPointerMissed={() => {
            setSelectedCharacterId(null);
            setHoveredCharacterId(null);
          }}
        >
          <Scene
            characters={renderCharacters}
            onSelectCharacter={setSelectedCharacterId}
            hoveredCharacterId={hoveredCharacterId}
            onHoverCharacter={setHoveredCharacterId}
          />
        </Canvas>
      </div>
      <CharacterInspector character={selectedCharacter} />
    </div>
  );
}
