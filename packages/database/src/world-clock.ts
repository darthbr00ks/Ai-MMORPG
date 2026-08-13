import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { gameCycles } from './schema.js';

/**
 * The world's game clock must be a durable reference point, not an
 * in-process `new Date()` — otherwise restarting the worker resets the
 * game day to 0 and the web app (a separate process) has no way to
 * compute "today" at all. We treat the `started_at` of the day-0
 * `game_cycles` row as the world epoch: create it once, on first use,
 * and every subsequent caller (worker tick loop, web API routes) reads
 * the same row instead of re-deriving its own start time.
 */
export async function getWorldEpoch(db: Db): Promise<Date> {
  const [existing] = await db
    .select()
    .from(gameCycles)
    .where(eq(gameCycles.dayNumber, 0))
    .limit(1);

  if (existing) {
    return existing.startedAt;
  }

  const [created] = await db
    .insert(gameCycles)
    .values({ dayNumber: 0, startedAt: new Date() })
    .returning({ startedAt: gameCycles.startedAt });

  return created.startedAt;
}
