import { loadRootEnv } from '@ai-world/shared';

// Same rationale as apps/simulation-worker/vitest.setup.ts: vitest
// doesn't inherit Next.js's automatic .env loading, so without this
// DATABASE_URL is undefined when permissions.test.ts evaluates its
// `describe.skipIf(!DB_URL)`, and the ownership-enforcement integration
// test silently skips instead of actually running.
loadRootEnv(process.cwd());
