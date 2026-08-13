import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { schema } from '@ai-world/database';
import { gt, desc } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let lastEventCreatedAt = new Date(Date.now() - 60_000);
      let active = true;

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
          })
          .from(schema.gameEvents)
          .orderBy(desc(schema.gameEvents.createdAt))
          .limit(10);

        for (const event of recent.reverse()) {
          const data = `data: ${JSON.stringify(event)}\n\n`;
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
            })
            .from(schema.gameEvents)
            .where(gt(schema.gameEvents.createdAt, lastEventCreatedAt))
            .orderBy(schema.gameEvents.createdAt)
            .limit(20);

          for (const event of newEvents) {
            const data = `data: ${JSON.stringify(event)}\n\n`;
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
