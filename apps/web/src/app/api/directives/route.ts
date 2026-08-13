import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getAiProvider } from '@/lib/ai-provider';
import { schema, getWorldEpoch } from '@ai-world/database';
import { eq, and } from 'drizzle-orm';
import { validateDirective, canSubmitDirective } from '@ai-world/game-engine';
import { gameTimeNow, loadConfig } from '@ai-world/shared';
import { z } from 'zod';

const DirectiveSubmitSchema = z.object({
  characterId: z.string().uuid(),
  text: z.string().min(1).max(500),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const parsed = DirectiveSubmitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.format() },
      { status: 400 }
    );
  }

  const { characterId, text } = parsed.data;
  const config = loadConfig();
  const db = getDb();

  // Validate directive content (length/emptiness — §3/§54 of the build plan)
  const validation = validateDirective(text, config.DIRECTIVE_MAX_CHARACTERS);
  if (!validation.valid) {
    return NextResponse.json({ error: validation.reason }, { status: 400 });
  }

  // Verify user owns this character
  const ownership = await db
    .select()
    .from(schema.characterOwnership)
    .where(
      and(
        eq(schema.characterOwnership.characterId, characterId),
        eq(schema.characterOwnership.userId, session.user.id as string),
        eq(schema.characterOwnership.active, true)
      )
    )
    .limit(1);

  if (ownership.length === 0) {
    return NextResponse.json(
      { error: 'You do not own this character' },
      { status: 403 }
    );
  }

  // Compute the real, persisted current game day — never hardcoded.
  const epoch = await getWorldEpoch(db);
  const gameDay = gameTimeNow(epoch, config.GAME_DAY_REAL_SECONDS).day;

  // One directive per game day (§3, §54 acceptance checklist): if the
  // character's currently-active directive was submitted on today's
  // game day, reject the resubmission and leave it untouched.
  const [currentActive] = await db
    .select()
    .from(schema.directives)
    .where(
      and(
        eq(schema.directives.characterId, characterId),
        eq(schema.directives.active, true)
      )
    )
    .limit(1);

  const submitCheck = canSubmitDirective(currentActive?.gameDay ?? null, gameDay);
  if (!submitCheck.valid) {
    return NextResponse.json({ error: submitCheck.reason }, { status: 409 });
  }

  // Moderate before activating — an accepted directive replaces the
  // previous one; a rejected/flagged directive leaves the previous
  // directive active and is recorded for the admin console (§13).
  const moderation = await getAiProvider().moderateDirective(text);

  if (moderation.status === 'rejected') {
    const [rejectedDirective] = await db
      .insert(schema.directives)
      .values({ characterId, userId: session.user.id as string, text, gameDay, active: false })
      .returning();

    await db.insert(schema.moderationRecords).values({
      directiveId: rejectedDirective.id,
      outcome: 'rejected',
      reasonCategory: moderation.reason_category,
    });

    return NextResponse.json(
      { error: 'Directive rejected by moderation', reason: moderation.reason_category },
      { status: 422 }
    );
  }

  // Accepted (or flagged-but-allowed) — deactivate the previous directive
  // and activate the new one.
  await db
    .update(schema.directives)
    .set({ active: false })
    .where(
      and(
        eq(schema.directives.characterId, characterId),
        eq(schema.directives.active, true)
      )
    );

  const [directive] = await db
    .insert(schema.directives)
    .values({
      characterId,
      userId: session.user.id as string,
      text,
      gameDay,
      active: true,
    })
    .returning();

  await db.insert(schema.moderationRecords).values({
    directiveId: directive.id,
    outcome: moderation.status,
    reasonCategory: moderation.reason_category,
  });

  await db.insert(schema.gameEvents).values({
    type: 'DIRECTIVE_SUBMITTED',
    actorCharacterId: characterId,
    payload: { directive_id: directive.id, text_length: text.length, game_day: gameDay },
    importance: 0.4,
  });

  return NextResponse.json({ success: true, directive });
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const characterId = searchParams.get('characterId');

  if (!characterId) {
    return NextResponse.json({ error: 'characterId required' }, { status: 400 });
  }

  // Directive history is owner-only — §52's private/public split. A
  // character's directive is not part of its public profile.
  const db = getDb();
  const ownership = await db
    .select()
    .from(schema.characterOwnership)
    .where(
      and(
        eq(schema.characterOwnership.characterId, characterId),
        eq(schema.characterOwnership.userId, session.user.id as string),
        eq(schema.characterOwnership.active, true)
      )
    )
    .limit(1);

  if (ownership.length === 0) {
    return NextResponse.json(
      { error: 'You do not own this character' },
      { status: 403 }
    );
  }

  const history = await db
    .select()
    .from(schema.directives)
    .where(eq(schema.directives.characterId, characterId))
    .orderBy(schema.directives.submittedAt);

  return NextResponse.json({ directives: history });
}
