import { loadRootEnv } from '@ai-world/shared';

// Vitest workers, like every other plain Node entry point in this
// monorepo, don't get the repo-root .env for free (see
// packages/shared/src/load-env.ts for why). Without this, DATABASE_URL
// is undefined when tick-integration.test.ts evaluates its
// `describe.skipIf(!DB_URL)` at module load time, so the real-Postgres
// integration test silently skips itself even when Postgres is up and
// migrated — defeating the acceptance checklist's "pnpm test passes
// ... one full integration path" bar.
loadRootEnv(process.cwd());
