import { NextRequest, NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/admin';
import { getDb } from '@/lib/db';
import {
  getOrCreateSimulationControl,
  setSimulationPaused,
  setSimulationSpeedMultiplier,
  queueManualTicks,
} from '@ai-world/database';
import { loadConfig } from '@ai-world/shared';
import { z } from 'zod';

const ActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('run_tick') }),
  z.object({ action: z.literal('run_day') }),
  z.object({ action: z.literal('set_speed'), speedMultiplier: z.number().positive() }),
]);

export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const control = await getOrCreateSimulationControl(getDb());
  return NextResponse.json({ control });
}

export async function POST(req: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json();
  const parsed = ActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.format() }, { status: 400 });
  }

  const db = getDb();

  switch (parsed.data.action) {
    case 'pause':
      await setSimulationPaused(db, true);
      break;
    case 'resume':
      await setSimulationPaused(db, false);
      break;
    case 'run_tick':
      await queueManualTicks(db, 1);
      break;
    case 'run_day': {
      // Every tick, paused or not, that lands within one game day —
      // same math the worker itself uses to reason about the clock.
      const config = loadConfig();
      const ticksPerDay = Math.ceil(config.GAME_DAY_REAL_SECONDS / config.SIMULATION_TICK_SECONDS);
      await queueManualTicks(db, ticksPerDay);
      break;
    }
    case 'set_speed':
      await setSimulationSpeedMultiplier(db, parsed.data.speedMultiplier);
      break;
  }

  const control = await getOrCreateSimulationControl(db);
  return NextResponse.json({ control });
}
