/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@ai-world/shared', '@ai-world/database', '@ai-world/game-engine'],
};
module.exports = nextConfig;
