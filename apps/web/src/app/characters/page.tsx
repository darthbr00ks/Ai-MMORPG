import { getDb } from '@/lib/db';
import { schema } from '@ai-world/database';
import { eq } from 'drizzle-orm';
import { CharacterAvatar } from '@/components/CharacterAvatar';

export const dynamic = 'force-dynamic';

type CharacterRow = {
  id: string;
  name: string;
  age: number;
  archetype: string;
  personalityTraits: unknown;
  locationName: string | null;
  status: 'idle' | 'working' | 'traveling' | 'conversing' | 'sleeping' | 'planning' | null;
  health: number | null;
  fatigue: number | null;
  walletCents: number | null;
};

async function getCharacters(): Promise<CharacterRow[]> {
  try {
    return await getDb()
      .select({
        id: schema.characters.id,
        name: schema.characters.name,
        age: schema.characters.age,
        archetype: schema.characters.archetype,
        personalityTraits: schema.characters.personalityTraits,
        locationName: schema.locations.name,
        status: schema.characterState.status,
        health: schema.characterState.health,
        fatigue: schema.characterState.fatigue,
        walletCents: schema.wallets.balanceCents,
      })
      .from(schema.characters)
      .leftJoin(
        schema.characterState,
        eq(schema.characters.id, schema.characterState.characterId)
      )
      .leftJoin(
        schema.locations,
        eq(schema.characterState.locationId, schema.locations.id)
      )
      .leftJoin(
        schema.wallets,
        eq(schema.characters.id, schema.wallets.characterId)
      )
      .orderBy(schema.characters.name);
  } catch (err) {
    // Swallowing this silently (the previous behavior) makes a real
    // outage — bad DATABASE_URL, DB down, missing env — look identical
    // to "no characters yet" in the UI. Surface it in server logs at
    // minimum so it's debuggable instead of a silent empty grid.
    console.error('[characters] failed to load character list:', err);
    return [];
  }
}

export default async function CharactersPage() {
  const characters = await getCharacters();

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Characters of New Concord</h2>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {characters.map((char: CharacterRow) => {
          const traits = (char.personalityTraits as Array<{ trait: string; weight: number }>) || [];
          const topTrait = [...traits].sort((a, b) => b.weight - a.weight)[0];
          return (
            <a
              key={char.id}
              href={`/characters/${char.id}`}
              className="block bg-gray-900 rounded-lg p-4 border border-gray-800 hover:border-amber-600 transition-colors"
            >
              <div className="flex justify-between items-start mb-2">
                <div className="flex items-center gap-3">
                  <CharacterAvatar seed={char.id} size={48} className="shrink-0 rounded-full bg-gray-800" />
                  <div>
                    <h3 className="font-bold text-lg">{char.name}</h3>
                    <p className="text-gray-400 text-sm">Age {char.age} · {char.archetype}</p>
                  </div>
                </div>
                <span
                  className={`text-xs px-2 py-1 rounded ${
                    char.status === 'working'
                      ? 'bg-green-900 text-green-300'
                      : char.status === 'traveling'
                      ? 'bg-blue-900 text-blue-300'
                      : 'bg-gray-800 text-gray-400'
                  }`}
                >
                  {char.status ?? 'unknown'}
                </span>
              </div>
              <div className="text-sm text-gray-400 space-y-1">
                <div>📍 {char.locationName ?? 'Unknown'}</div>
                <div>💰 {((char.walletCents ?? 0) / 100).toFixed(2)} gold</div>
                {topTrait && (
                  <div>🎭 {topTrait.trait} ({Math.round(topTrait.weight * 100)}%)</div>
                )}
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}
