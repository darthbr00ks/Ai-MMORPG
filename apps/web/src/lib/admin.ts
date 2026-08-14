import { redirect } from 'next/navigation';
import { auth } from './auth';
import { getDb } from './db';
import { schema } from '@ai-world/database';
import { eq } from 'drizzle-orm';

/**
 * `users.role` is not part of the NextAuth session object (the
 * database session strategy only carries id/name/email/image) — so
 * every admin check queries the users table directly rather than
 * trusting anything client-supplied or session-cached. Cheap: one
 * indexed lookup by primary key.
 */
export async function getUserRole(userId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ role: schema.users.role })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return row?.role ?? null;
}

/**
 * For admin Server Component pages. Redirects rather than rendering
 * a 403 — this app has no dedicated error page yet, and sending an
 * unauthorized visitor back to sign-in (or the dashboard, if already
 * signed in as a non-admin) is a reasonable default until it does.
 */
export async function requireAdminPageSession() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/auth/signin');
  }
  const role = await getUserRole(session.user.id as string);
  if (role !== 'admin') {
    redirect('/');
  }
  return session;
}

/**
 * For admin Route Handlers. Returns the session when the caller is an
 * admin, `null` otherwise — the route itself decides the 401 vs. 403
 * NextResponse, matching the existing pattern in
 * api/directives/route.ts rather than throwing/redirecting from
 * inside a handler.
 */
export async function getAdminSession() {
  const session = await auth();
  if (!session?.user?.id) return null;
  const role = await getUserRole(session.user.id as string);
  if (role !== 'admin') return null;
  return session;
}
