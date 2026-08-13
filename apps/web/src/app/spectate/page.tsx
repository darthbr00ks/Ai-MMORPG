import EventFeed from '@/components/EventFeed';
import { getDb } from '@/lib/db';
import { schema } from '@ai-world/database';
import { eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

type CharacterRow = {
  id: string;
  name: string;
  archetype: string;
  status: 'idle' | 'working' | 'traveling' | 'conversing' | 'sleeping' | 'planning' | null;
  locationName: string | null;
};

async function getActiveCharacters(): Promise<CharacterRow[]> {
  try {
    return await getDb()
      .select({
        id: schema.characters.id,
        name: schema.characters.name,
        archetype: schema.characters.archetype,
        status: schema.characterState.status,
        locationName: schema.locations.name,
      })
      .from(schema.characters)
      .leftJoin(schema.characterState, eq(schema.characters.id, schema.characterState.characterId))
      .leftJoin(schema.locations, eq(schema.characterState.locationId, schema.locations.id))
      .orderBy(schema.characters.name)
      .limit(20);
  } catch {
    return [];
  }
}

export default async function SpectatePage() {
  const characters = await getActiveCharacters();

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Spectate — New Concord Live</h2>
      <div className="grid md:grid-cols-3 gap-6">
        <div className="md:col-span-2">
          <h3 className="text-lg font-semibold mb-3">Live Events</h3>
          <EventFeed />
        </div>
        <div>
          <h3 className="text-lg font-semibold mb-3">Characters</h3>
          <div className="space-y-2">
            {characters.map((c: CharacterRow) => (
              <a
                key={c.id}
                href={`/characters/${c.id}`}
                className="block bg-gray-900 rounded p-2 border border-gray-800 hover:border-gray-600 text-sm"
              >
                <div className="font-medium">{c.name}</div>
                <div className="text-gray-400 text-xs">{c.locationName} · {c.status}</div>
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
