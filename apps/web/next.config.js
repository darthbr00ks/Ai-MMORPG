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
};
module.exports = nextConfig;
