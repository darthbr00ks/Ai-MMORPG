import { getDb } from '@/lib/db';
import { schema } from '@ai-world/database';
import { count } from 'drizzle-orm';
import EventFeed from '@/components/EventFeed';

export const dynamic = 'force-dynamic';

async function getStats() {
  try {
    const [charCount] = await getDb().select({ count: count() }).from(schema.characters);
    const [eventCount] = await getDb().select({ count: count() }).from(schema.gameEvents);
    const [cycleCount] = await getDb().select({ count: count() }).from(schema.gameCycles);
    return {
      characters: charCount.count,
      events: eventCount.count,
      cycles: cycleCount.count,
    };
  } catch {
    return { characters: 0, events: 0, cycles: 0 };
  }
}

export default async function HomePage() {
  const stats = await getStats();

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold mb-2">New Concord</h2>
        <p className="text-gray-400">
          A persistent world of {stats.characters} autonomous AI characters. Give one a directive and watch what happens.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Characters" value={stats.characters} />
        <StatCard label="Game Events" value={stats.events} />
        <StatCard label="Simulation Cycles" value={stats.cycles} />
      </div>

      <div>
        <h3 className="text-xl font-semibold mb-4">Live Event Feed</h3>
        <EventFeed />
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
      <div className="text-2xl font-bold text-amber-400">{value}</div>
      <div className="text-gray-400 text-sm">{label}</div>
    </div>
  );
}
