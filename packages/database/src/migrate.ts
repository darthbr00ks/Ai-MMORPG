import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import path from 'path';

async function runMigrations() {
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
