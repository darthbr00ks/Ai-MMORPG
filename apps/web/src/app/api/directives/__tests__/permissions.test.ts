/**
 * Permission test (§14/§54 of the build plan): a character's directive
 * and its history are owner-only. User A must not be able to read (or
 * submit against) user B's character via this route.
 *
 * This is a real gap the review found — the original GET handler had NO
 * auth check at all (any unauthenticated caller could fetch any
 * character's directive history by id). That's fixed in route.ts; this
 * test guards the fix.
 *
 * Requires DATABASE_URL to point at a reachable, migrated Postgres —
 * skipped otherwise. `auth()` is mocked so this doesn't need a real
 * OAuth/email login flow, only real ownership rows in the DB.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema } from '@ai-world/database';
import { eq } from 'drizzle-orm';

const DB_URL = process.env.DATABASE_URL;

// Mocked before importing the route, so the route's `import { auth }`
// binds to this mock instead of the real NextAuth handler.
let mockSessionUserId: string | null = null;
vi.mock('@/lib/auth', () => ({
  auth: async () => (mockSessionUserId ? { user: { id: mockSessionUserId } } : null),
}));

describe.skipIf(!DB_URL)('GET /api/directives — ownership enforcement', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let ownerUserId: string;
  let intruderUserId: string;
  let characterId: string;

  beforeAll(async () => {
    client = postgres(DB_URL!);
    db = drizzle(client, { schema });

    const [owner] = await db
      .insert(schema.users)
      .values({ email: `owner-${Date.now()}@example.com` })
      .returning({ id: schema.users.id });
    ownerUserId = owner.id;

    const [intruder] = await db
      .insert(schema.users)
      .values({ email: `intruder-${Date.now()}@example.com` })
      .returning({ id: schema.users.id });
    intruderUserId = intruder.id;

    const [character] = await db
      .insert(schema.characters)
      .values({
        name: 'Owned Character',
        age: 25,
        background: 'Belongs to the owner user only.',
        personalityTraits: [],
        skills: [],
        ambitions: [],
        archetype: 'peacekeeper',
      })
      .returning({ id: schema.characters.id });
    characterId = character.id;

    await db.insert(schema.characterOwnership).values({
      characterId,
      userId: ownerUserId,
      active: true,
    });

    await db.insert(schema.directives).values({
      characterId,
      userId: ownerUserId,
      text: 'A private directive only the owner should see.',
      gameDay: 0,
      active: true,
    });
  });

  afterAll(async () => {
    await db.delete(schema.directives).where(eq(schema.directives.characterId, characterId));
    await db.delete(schema.characterOwnership).where(eq(schema.characterOwnership.characterId, characterId));
    await db.delete(schema.characters).where(eq(schema.characters.id, characterId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    await db.delete(schema.users).where(eq(schema.users.id, intruderUserId));
    await client.end();
  });

  it('returns 401 for an unauthenticated request', async () => {
    mockSessionUserId = null;
    const { GET } = await import('../route.js');
    const req = new NextRequest(`http://localhost/api/directives?characterId=${characterId}`);
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 403 when a different user requests the character\'s directive history', async () => {
    mockSessionUserId = intruderUserId;
    const { GET } = await import('../route.js');
    const req = new NextRequest(`http://localhost/api/directives?characterId=${characterId}`);
    const res = await GET(req);
    expect(res.status).toBe(403);
  });

  it('returns 200 with the directive history for the actual owner', async () => {
    mockSessionUserId = ownerUserId;
    const { GET } = await import('../route.js');
    const req = new NextRequest(`http://localhost/api/directives?characterId=${characterId}`);
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.directives.length).toBeGreaterThanOrEqual(1);
  });
});
