import { and, eq, gt, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { simulationControl } from './schema.js';

// There is exactly one simulation, so exactly one control row.
const CONTROL_ROW_ID = 'default';

// Keeps a runaway admin request from stalling or racing the tick
// loop — same rationale as clamping any other user-facing numeric
// input.
const MIN_SPEED_MULTIPLIER = 0.1;
const MAX_SPEED_MULTIPLIER = 10;
const MAX_QUEUED_MANUAL_TICKS = 10_000; // generous headroom above one game day's tick count

export interface SimulationControlState {
  id: string;
  paused: boolean;
  speedMultiplier: number;
  pendingManualTicks: number;
  updatedAt: Date;
}

/**
 * Reads the singleton control row, creating it with defaults
 * (running, 1x speed, no queued manual ticks) on first use — same
 * lazy-create-on-first-read pattern as getWorldEpoch in
 * world-clock.ts, so neither the worker nor the admin console needs
 * to know which one runs first.
 */
export async function getOrCreateSimulationControl(db: Db): Promise<SimulationControlState> {
  const [existing] = await db
    .select()
    .from(simulationControl)
    .where(eq(simulationControl.id, CONTROL_ROW_ID))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(simulationControl)
    .values({ id: CONTROL_ROW_ID })
    .onConflictDoNothing()
    .returning();
  // A concurrent caller may have won the insert race — either way,
  // the row now exists; read it back rather than assume `created`.
  if (created) return created;
  const [row] = await db
    .select()
    .from(simulationControl)
    .where(eq(simulationControl.id, CONTROL_ROW_ID))
    .limit(1);
  return row;
}

export async function setSimulationPaused(db: Db, paused: boolean): Promise<void> {
  await getOrCreateSimulationControl(db);
  await db
    .update(simulationControl)
    .set({ paused, updatedAt: new Date() })
    .where(eq(simulationControl.id, CONTROL_ROW_ID));
}

export async function setSimulationSpeedMultiplier(db: Db, multiplier: number): Promise<void> {
  const clamped = Math.min(MAX_SPEED_MULTIPLIER, Math.max(MIN_SPEED_MULTIPLIER, multiplier));
  await getOrCreateSimulationControl(db);
  await db
    .update(simulationControl)
    .set({ speedMultiplier: clamped, updatedAt: new Date() })
    .where(eq(simulationControl.id, CONTROL_ROW_ID));
}

/** Queues `count` manual ticks — "Run 1 Tick" queues 1, "Run 1 Day"
 * queues however many ticks make up a game day. Additive: queuing
 * while ticks are already pending adds to the total rather than
 * replacing it. */
export async function queueManualTicks(db: Db, count: number): Promise<void> {
  if (count <= 0) return;
  const bounded = Math.min(count, MAX_QUEUED_MANUAL_TICKS);
  await getOrCreateSimulationControl(db);
  await db
    .update(simulationControl)
    .set({
      pendingManualTicks: sql`LEAST(${simulationControl.pendingManualTicks} + ${bounded}, ${MAX_QUEUED_MANUAL_TICKS})`,
      updatedAt: new Date(),
    })
    .where(eq(simulationControl.id, CONTROL_ROW_ID));
}

/**
 * Atomically claims one queued manual tick, if any remain — the
 * `WHERE pendingManualTicks > 0` guard means two overlapping checks
 * (there is only ever one worker process today, but this makes that
 * an operational fact rather than a correctness requirement) can
 * never both claim the same tick. Returns true if a tick was claimed.
 */
export async function claimPendingManualTick(db: Db): Promise<boolean> {
  const [claimed] = await db
    .update(simulationControl)
    .set({ pendingManualTicks: sql`${simulationControl.pendingManualTicks} - 1`, updatedAt: new Date() })
    .where(and(eq(simulationControl.id, CONTROL_ROW_ID), gt(simulationControl.pendingManualTicks, 0)))
    .returning({ id: simulationControl.id });
  return !!claimed;
}
