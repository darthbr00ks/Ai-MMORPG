/**
 * Permission test (§13/§15 of the build plan): the admin console's
 * Simulation Test Mode controls must only be reachable by a user whose
 * `users.role` is 'admin' — everyone else, including a signed-in
 * non-admin, gets 403.
 *
 * Requires DATABASE_URL to point at a reachable, migrated Postgres —
 * skipped otherwise. `auth()` is mocked so this doesn't need a real
 * OAuth/email login flow, only real users rows with the role under
 * test.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema } from '@ai-world/database';
import { eq } from 'drizzle-orm';

const DB_URL = process.env.DATABASE_URL;

// Mocked before importing the route, so the route's
// `import { getAdminSession } from '@/lib/admin'` chain binds to this
// mock's auth() instead of the real NextAuth handler. getAdminSession
// itself is NOT mocked — its real role lookup against the DB is
// exactly what this test verifies.
let mockSessionUserId: string | null = null;
vi.mock('@/lib/auth', () => ({
  auth: async () => (mockSessionUserId ? { user: { id: mockSessionUserId } } : null),
}));

describe.skipIf(!DB_URL)('POST /api/admin/simulation-control — role enforcement', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let adminUserId: string;
  let playerUserId: string;

  beforeAll(async () => {
    client = postgres(DB_URL!);
    db = drizzle(client, { schema });

    const [admin] = await db
      .insert(schema.users)
      .values({ email: `admin-${Date.now()}@example.com`, role: 'admin' })
      .returning({ id: schema.users.id });
    adminUserId = admin.id;

    const [player] = await db
      .insert(schema.users)
      .values({ email: `player-${Date.now()}@example.com`, role: 'player' })
      .returning({ id: schema.users.id });
    playerUserId = player.id;
  });

  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
    await db.delete(schema.users).where(eq(schema.users.id, playerUserId));
    await client.end();
  });

  it('returns 403 for an unauthenticated request', async () => {
    mockSessionUserId = null;
    const { POST } = await import('../route.js');
    const req = new NextRequest('http://localhost/api/admin/simulation-control', {
      method: 'POST',
      body: JSON.stringify({ action: 'pause' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it('returns 403 for a signed-in non-admin user', async () => {
    mockSessionUserId = playerUserId;
    const { POST } = await import('../route.js');
    const req = new NextRequest('http://localhost/api/admin/simulation-control', {
      method: 'POST',
      body: JSON.stringify({ action: 'pause' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it('returns 200 for an admin user and actually pauses the simulation', async () => {
    mockSessionUserId = adminUserId;
    const { POST } = await import('../route.js');
    const req = new NextRequest('http://localhost/api/admin/simulation-control', {
      method: 'POST',
      body: JSON.stringify({ action: 'pause' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.control.paused).toBe(true);

    // Leave it as found for any other test/dev session sharing this DB.
    const resumeReq = new NextRequest('http://localhost/api/admin/simulation-control', {
      method: 'POST',
      body: JSON.stringify({ action: 'resume' }),
    });
    await POST(resumeReq);
  });
});
