# 3D World Renderer Architecture

## Goal

Replace the current SVG world map as the primary spectator interface with a small stylized 3D town while leaving the simulation, AI, and persistence layers intact.

## Current Boundary

The existing graph-like world view is presentation-only:

- `apps/web/src/components/WorldMap.tsx`
- `apps/web/src/components/CharacterAvatar.tsx`
- `apps/web/src/lib/world-layout.ts`

The simulation/data boundary already exists below that UI:

- `apps/web/src/app/api/world/snapshot/route.ts`
- `apps/web/src/app/api/events/stream/route.ts`
- `apps/simulation-worker/src/tick-processor.ts`
- `packages/game-engine/*`
- `packages/database/*`

## Minimal Change

Keep the current simulation model and replace only the world presentation layer.

```text
AI decisions
    ↓
Simulation worker
    ↓
World snapshot + event stream
    ↓
3D renderer
```

## Vertical Slice Scope

The first milestone renders a small 3D settlement containing:

- Grass terrain
- Roads
- Town square
- Tavern
- Market
- Farm
- Additional support buildings already present in the seeded town graph
- Full-body bear characters
- Character selection
- Speech bubbles
- Character movement between locations
- Face-to-face conversation staging inside a location

## Renderer Design

### Data sources

- `useWorldSnapshot` polls `/api/world/snapshot` for authoritative location/status data
- `useWorldEvents` subscribes to `/api/events/stream` for transient movement/conversation effects

### Scene layout

`apps/web/src/lib/world-scene-layout.ts` defines:

- Stable 3D positions for each existing seeded location slug
- Building types and footprints
- Road segments
- A simple walkable navigation grid
- A* pathfinding for movement
- Character anchor spots around a location

This keeps world geometry and navigation in one presentation-layer module without changing the database schema.

### Characters

Milestone 1 uses procedural low-poly teddy bear humanoids built from meshes, but the component boundary is intentionally renderer-facing rather than data-facing:

- the scene consumes appearance/state data
- the bear body implementation can later be swapped for GLTF assets

### Movement

- snapshot location remains authoritative
- travel events create temporary client-side travel plans
- the 3D layer computes path points over the navigation grid
- characters animate along those paths until the snapshot catches up

### Conversations

Conversation events create temporary in-world meeting formations:

- participants walk to paired talk spots
- rotate toward one another
- speech bubbles display one utterance at a time
- participants return to their regular location anchors when the exchange ends

## Deliberate Non-Goals

This milestone does not change:

- AI decision logic
- economic rules
- faction mechanics
- relationship math
- database structure beyond richer snapshot fields needed by the renderer

The old relationship-heavy graph should survive only as a secondary diplomacy view, not the default world.
