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
