import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { schema } from '@ai-world/database';
import { gt, desc } from 'drizzle-orm';
import { describeGameEvent } from '@ai-world/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RawGameEvent {
  id: string;
  type: string;
  importance: number;
  payload: unknown;
  createdAt: Date;
  actorCharacterId: string | null;
  targetCharacterId: string | null;
  locationId: string | null;
}

/**
 * Resolves actorCharacterId/targetCharacterId/locationId into
 * display names before the event goes out over SSE. Previously this
 * route only ever sent the raw ids — EventFeed's `actorName` field
 * has been silently undefined since it was written, since nothing
 * populated it. Fetched once per connection (a spectator connection
 * is short-lived, and characters/locations essentially never change
 * mid-connection at this project's current scope), not re-queried on
 * every 2s poll.
 */
async function buildNameLookup(): Promise<{
  characterNameById: Map<string, string>;
  locationNameById: Map<string, string>;
}> {
  const characterRows: Array<{ id: string; name: string }> = await getDb()
    .select({ id: schema.characters.id, name: schema.characters.name })
    .from(schema.characters);
  const locationRows: Array<{ id: string; name: string }> = await getDb()
    .select({ id: schema.locations.id, name: schema.locations.name })
    .from(schema.locations);
  const characterNameById = new Map<string, string>(characterRows.map((c) => [c.id, c.name]));
  const locationNameById = new Map<string, string>(locationRows.map((l) => [l.id, l.name]));
  return { characterNameById, locationNameById };
}

function enrichEvent(
  event: RawGameEvent,
  characterNameById: Map<string, string>,
  locationNameById: Map<string, string>
) {
  return {
    ...event,
    actorName: event.actorCharacterId ? characterNameById.get(event.actorCharacterId) ?? null : null,
    targetName: event.targetCharacterId ? characterNameById.get(event.targetCharacterId) ?? null : null,
    locationName: event.locationId ? locationNameById.get(event.locationId) ?? null : null,
    // Computed server-side (this route already depends on
    // @ai-world/shared) so clients — including the broadcast view,
    // a 'use client' component — never need to import shared business
    // logic just to render a sentence.
    description: describeGameEvent(event),
  };
}

export async function GET(_req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let lastEventCreatedAt = new Date(Date.now() - 60_000);
      let active = true;

      const { characterNameById, locationNameById } = await buildNameLookup().catch(() => ({
        characterNameById: new Map<string, string>(),
        locationNameById: new Map<string, string>(),
      }));

      // Send recent events on connect
      try {
        const recent = await getDb()
          .select({
            id: schema.gameEvents.id,
            type: schema.gameEvents.type,
            importance: schema.gameEvents.importance,
            payload: schema.gameEvents.payload,
            createdAt: schema.gameEvents.createdAt,
            actorCharacterId: schema.gameEvents.actorCharacterId,
            targetCharacterId: schema.gameEvents.targetCharacterId,
            locationId: schema.gameEvents.locationId,
          })
          .from(schema.gameEvents)
          .orderBy(desc(schema.gameEvents.createdAt))
          .limit(10);

        for (const event of recent.reverse()) {
          const data = `data: ${JSON.stringify(enrichEvent(event, characterNameById, locationNameById))}\n\n`;
          controller.enqueue(encoder.encode(data));
          if (event.createdAt > lastEventCreatedAt) {
            lastEventCreatedAt = event.createdAt;
          }
        }
      } catch {
        // DB not ready on first connect
      }

      // Poll for new events
      const interval = setInterval(async () => {
        if (!active) return;

        try {
          const newEvents = await getDb()
            .select({
              id: schema.gameEvents.id,
              type: schema.gameEvents.type,
              importance: schema.gameEvents.importance,
              payload: schema.gameEvents.payload,
              createdAt: schema.gameEvents.createdAt,
              actorCharacterId: schema.gameEvents.actorCharacterId,
              targetCharacterId: schema.gameEvents.targetCharacterId,
              locationId: schema.gameEvents.locationId,
            })
            .from(schema.gameEvents)
            .where(gt(schema.gameEvents.createdAt, lastEventCreatedAt))
            .orderBy(schema.gameEvents.createdAt)
            .limit(20);

          for (const event of newEvents) {
            const data = `data: ${JSON.stringify(enrichEvent(event, characterNameById, locationNameById))}\n\n`;
            controller.enqueue(encoder.encode(data));
            lastEventCreatedAt = event.createdAt;
          }

          // Heartbeat
          controller.enqueue(encoder.encode('event: heartbeat\ndata: {}\n\n'));
        } catch {
          // ignore poll errors
        }
      }, 2000);

      return () => {
        active = false;
        clearInterval(interval);
      };
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
