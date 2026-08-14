/**
 * Integration test for Phase 15's Simulation Test Mode control row
 * (§13 — Pause/Resume/Run 1 Tick/Run 1 Day/speed multipliers). Runs
 * against a real Postgres; skipped without DATABASE_URL like the
 * rest of this suite.
 *
 * simulation_control is a genuine singleton (id is always the literal
 * 'default'), so unlike every other test in this suite there is no
 * per-test row to create and tear down — tests instead save/restore
 * the row's state around themselves.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { schema } from '@ai-world/database';
import {
  getOrCreateSimulationControl,
  setSimulationPaused,
  setSimulationSpeedMultiplier,
  queueManualTicks,
  claimPendingManualTick,
} from '@ai-world/database';

const DB_URL = process.env.DATABASE_URL;
const CONTROL_ROW_ID = 'default';

describe.skipIf(!DB_URL)('simulation control', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = postgres(DB_URL!);
    db = drizzle(client, { schema });
    // Reset to defaults before every test — a genuine singleton row
    // can't be isolated per test any other way.
    await getOrCreateSimulationControl(db);
    await db
      .update(schema.simulationControl)
      .set({ paused: false, speedMultiplier: 1, pendingManualTicks: 0 })
      .where(eq(schema.simulationControl.id, CONTROL_ROW_ID));
  });

  afterAll(async () => {
    await db
      .update(schema.simulationControl)
      .set({ paused: false, speedMultiplier: 1, pendingManualTicks: 0 })
      .where(eq(schema.simulationControl.id, CONTROL_ROW_ID));
    await client.end();
  });

  it('creates the row with defaults on first read', async () => {
    const control = await getOrCreateSimulationControl(db);
    expect(control.paused).toBe(false);
    expect(control.speedMultiplier).toBe(1);
    expect(control.pendingManualTicks).toBe(0);
  });

  it('pause/resume toggle the paused flag', async () => {
    await setSimulationPaused(db, true);
    expect((await getOrCreateSimulationControl(db)).paused).toBe(true);

    await setSimulationPaused(db, false);
    expect((await getOrCreateSimulationControl(db)).paused).toBe(false);
  });

  it('clamps the speed multiplier to a sane range', async () => {
    await setSimulationSpeedMultiplier(db, 1000);
    expect((await getOrCreateSimulationControl(db)).speedMultiplier).toBe(10);

    await setSimulationSpeedMultiplier(db, 0.0001);
    expect((await getOrCreateSimulationControl(db)).speedMultiplier).toBe(0.1);

    await setSimulationSpeedMultiplier(db, 3);
    expect((await getOrCreateSimulationControl(db)).speedMultiplier).toBe(3);
  });

  it('queues manual ticks additively', async () => {
    await queueManualTicks(db, 5);
    expect((await getOrCreateSimulationControl(db)).pendingManualTicks).toBe(5);

    await queueManualTicks(db, 3);
    expect((await getOrCreateSimulationControl(db)).pendingManualTicks).toBe(8);
  });

  it('claims one pending tick at a time, returning false when none remain', async () => {
    await queueManualTicks(db, 2);

    expect(await claimPendingManualTick(db)).toBe(true);
    expect((await getOrCreateSimulationControl(db)).pendingManualTicks).toBe(1);

    expect(await claimPendingManualTick(db)).toBe(true);
    expect((await getOrCreateSimulationControl(db)).pendingManualTicks).toBe(0);

    // Nothing left to claim — must not go negative.
    expect(await claimPendingManualTick(db)).toBe(false);
    expect((await getOrCreateSimulationControl(db)).pendingManualTicks).toBe(0);
  });
});
