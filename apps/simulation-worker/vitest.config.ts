import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    passWithNoTests: true,
    setupFiles: ['./vitest.setup.ts'],
    // This package's integration tests (tick-integration.test.ts,
    // memory-extraction.test.ts) all hit ONE real Postgres via
    // processTick, which sweeps the entire characters table rather
    // than just a test's own rows. Running the two files in parallel
    // worker threads (Vitest's default) opened a real race: one
    // file's afterAll could snapshot "this character's decisions" for
    // cleanup while the other file's processTick call was mid-write
    // against an overlapping tick, occasionally leaving an
    // agent_actions/ai_usage row the snapshot hadn't seen yet and
    // turning a routine cleanup DELETE into a live FK violation.
    // Observed directly: a full `pnpm test` run failed on this
    // roughly 1-in-3 times, always healed on retry. Serializing file
    // execution for this package trades a small amount of wall-clock
    // time for eliminating that class of flake outright.
    fileParallelism: false,
  },
});
