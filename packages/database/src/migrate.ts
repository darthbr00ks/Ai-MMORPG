import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import path from 'path';
import { loadRootEnv } from '@ai-world/shared';

async function runMigrations() {
  // A plain Node script (unlike apps/web) — load the repo-root .env
  // before reading process.env.DATABASE_URL below.
  loadRootEnv(process.cwd());
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required');
  }
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  await migrate(db, {
    migrationsFolder: path.join(__dirname, '../migrations'),
  });
  console.log('Migrations complete');
  await client.end();
}

runMigrations().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
