import { getDb } from '@ai-world/database';

// Re-export lazy accessor — call getDb() inside each function that needs
// the database, not at module initialisation time, so next build doesn't
// crash when DATABASE_URL is absent from the build environment.
export { getDb };
