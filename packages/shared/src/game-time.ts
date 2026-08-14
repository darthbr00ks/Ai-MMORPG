export interface GameTime {
  day: number;
  ticksIntoDay: number;
  totalTicks: number;
  progressFraction: number; // 0..1 how far through the day
}

export function gameTimeNow(
  cycleStartedAt: Date,
  dayRealSeconds: number
): GameTime {
  const elapsedMs = Date.now() - cycleStartedAt.getTime();
  const elapsedSeconds = elapsedMs / 1000;
  const day = Math.floor(elapsedSeconds / dayRealSeconds);
  const secondsIntoDay = elapsedSeconds % dayRealSeconds;
  const progressFraction = secondsIntoDay / dayRealSeconds;
  return {
    day,
    ticksIntoDay: Math.floor(secondsIntoDay),
    totalTicks: Math.floor(elapsedSeconds),
    progressFraction,
  };
}

export function realMsUntilGameTime(
  target: GameTime,
  cycleStartedAt: Date,
  dayRealSeconds: number
): number {
  const targetRealSeconds =
    target.day * dayRealSeconds + target.ticksIntoDay;
  const targetMs = cycleStartedAt.getTime() + targetRealSeconds * 1000;
  return Math.max(0, targetMs - Date.now());
}

export function currentGameDay(
  cycleStartedAt: Date,
  dayRealSeconds: number
): number {
  return gameTimeNow(cycleStartedAt, dayRealSeconds).day;
}

export interface GameDayRealTimeWindow {
  start: Date;
  end: Date;
}

/**
 * The real-world [start, end) window a given game day number spans,
 * derived directly from the world epoch — independent of whether any
 * tick actually ran during that day. `game_cycles` rows are only
 * created lazily, the first time a tick observes a new day number
 * (see tick-processor.ts); a worker outage or restart spanning a day
 * boundary must not cause that day's window to be unrecoverable just
 * because no row happens to exist for it.
 */
export function gameDayRealTimeWindow(
  dayNumber: number,
  cycleStartedAt: Date,
  dayRealSeconds: number
): GameDayRealTimeWindow {
  const start = new Date(cycleStartedAt.getTime() + dayNumber * dayRealSeconds * 1000);
  const end = new Date(start.getTime() + dayRealSeconds * 1000);
  return { start, end };
}
