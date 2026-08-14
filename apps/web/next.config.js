const path = require('path');

// Next.js only auto-loads .env files from this directory (apps/web),
// never from the monorepo root — but the documented setup
// (`cp .env.example .env`) puts one file at the repo root for every
// package to share. Load it explicitly before Next reads process.env.
// dotenv never overrides a variable that's already set, so this is
// safe alongside real deployment env injection.
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@ai-world/shared', '@ai-world/database', '@ai-world/game-engine'],
  // Produces .next/standalone — a self-contained server bundle with
  // only the node_modules Next's build tracer determined are actually
  // required, instead of the full workspace node_modules tree. This
  // is what keeps the Phase 16 Docker image (apps/web/Dockerfile)
  // small and avoids re-solving pnpm's node_modules layout inside the
  // final image.
  output: 'standalone',
};
module.exports = nextConfig;
