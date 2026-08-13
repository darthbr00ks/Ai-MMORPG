import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { schema } from '@ai-world/database';
import { eq, and } from 'drizzle-orm';
import { validateDirective } from '@ai-world/game-engine';
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

  // Validate directive content
  const validation = validateDirective(text);
  if (!validation.valid) {
    return NextResponse.json({ error: validation.reason }, { status: 400 });
  }

  // Verify user owns this character
  const ownership = await getDb()
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

  // Check if already submitted today (game day lock)
  // For now, allow one active directive
  // Deactivate previous directives
  await getDb()
    .update(schema.directives)
    .set({ active: false })
    .where(
      and(
        eq(schema.directives.characterId, characterId),
        eq(schema.directives.active, true)
      )
    );

  // Mock moderation (replace with real provider in prod)
  const moderationStatus = 'accepted';

  // Insert new directive
  const [directive] = await getDb()
    .insert(schema.directives)
    .values({
      characterId,
      userId: session.user.id as string,
      text,
      gameDay: 0, // TODO: get from game clock
      active: true,
    })
    .returning();

  // Record moderation
  await getDb().insert(schema.moderationRecords).values({
    directiveId: directive.id,
    outcome: moderationStatus,
    reasonCategory: '',
  });

  // Write game event
  await getDb().insert(schema.gameEvents).values({
    type: 'DIRECTIVE_SUBMITTED',
    actorCharacterId: characterId,
    payload: { directive_id: directive.id, text_length: text.length },
    importance: 0.4,
  });

  return NextResponse.json({ success: true, directive });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const characterId = searchParams.get('characterId');

  if (!characterId) {
    return NextResponse.json({ error: 'characterId required' }, { status: 400 });
  }

  const history = await getDb()
    .select()
    .from(schema.directives)
    .where(eq(schema.directives.characterId, characterId))
    .orderBy(schema.directives.submittedAt);

  return NextResponse.json({ directives: history });
}
