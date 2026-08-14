import { config as loadDotenvFile } from 'dotenv';
import { existsSync } from 'fs';
import path from 'path';

/**
 * Every plain Node entry point in this monorepo (simulation-worker,
 * database migrate/seed scripts) needs the repo-root `.env` loaded
 * before it reads `process.env` — unlike Next.js, which does this
 * automatically for apps/web. `pnpm dev`/`db:migrate`/`db:seed` run
 * with cwd set to the invoking package's directory (not the repo
 * root), so a bare `dotenv.config()` looks in the wrong place. Walk up
 * from the caller's directory until `pnpm-workspace.yaml` is found,
 * and load `.env` from there — works regardless of which package
 * calls it or how it was invoked.
 */
export function loadRootEnv(startDir: string): void {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      loadDotenvFile({ path: path.join(dir, '.env') });
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  // No workspace root found (e.g. running outside this repo) — fall
  // back to dotenv's own cwd-relative default rather than doing nothing.
  loadDotenvFile();
}
