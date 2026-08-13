import { getDb } from '@/lib/db';
import { schema } from '@ai-world/database';
import { eq, desc } from 'drizzle-orm';
import DirectiveForm from '@/components/DirectiveForm';

export const dynamic = 'force-dynamic';

async function getCharacter(id: string) {
  const [char] = await getDb()
    .select({
      id: schema.characters.id,
      name: schema.characters.name,
      age: schema.characters.age,
      background: schema.characters.background,
      archetype: schema.characters.archetype,
      personalityTraits: schema.characters.personalityTraits,
      skills: schema.characters.skills,
      ambitions: schema.characters.ambitions,
      locationName: schema.locations.name,
      locationSlug: schema.locations.slug,
      status: schema.characterState.status,
      health: schema.characterState.health,
      fatigue: schema.characterState.fatigue,
      walletCents: schema.wallets.balanceCents,
    })
    .from(schema.characters)
    .leftJoin(schema.characterState, eq(schema.characters.id, schema.characterState.characterId))
    .leftJoin(schema.locations, eq(schema.characterState.locationId, schema.locations.id))
    .leftJoin(schema.wallets, eq(schema.characters.id, schema.wallets.characterId))
    .where(eq(schema.characters.id, id))
    .limit(1);
  return char;
}

async function getDirectiveHistory(characterId: string) {
  return getDb()
    .select()
    .from(schema.directives)
    .where(eq(schema.directives.characterId, characterId))
    .orderBy(desc(schema.directives.submittedAt))
    .limit(10);
}

async function getRecentDecisions(characterId: string) {
  return getDb()
    .select()
    .from(schema.agentDecisions)
    .where(eq(schema.agentDecisions.characterId, characterId))
    .orderBy(desc(schema.agentDecisions.createdAt))
    .limit(10);
}

type Directive = {
  id: string;
  text: string;
  submittedAt: Date;
  active: boolean;
};

type Decision = {
  id: string;
  chosenAction: string;
  createdAt: Date;
  latencyMs: number | null;
};

export default async function CharacterDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const char = await getCharacter(params.id);
  if (!char) {
    return <div className="text-red-400">Character not found</div>;
  }

  const [directiveHistory, recentDecisions] = await Promise.all([
    getDirectiveHistory(params.id) as Promise<Directive[]>,
    getRecentDecisions(params.id) as Promise<Decision[]>,
  ]);

  const traits = (char.personalityTraits as Array<{ trait: string; weight: number }>) || [];
  const skills = (char.skills as string[]) || [];

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start">
        <div>
          <h2 className="text-3xl font-bold">{char.name}</h2>
          <p className="text-gray-400">Age {char.age} · {char.archetype}</p>
        </div>
        <span
          className={`text-sm px-3 py-1 rounded-full ${
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

      <div className="grid gap-4 md:grid-cols-2">
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <h3 className="font-semibold mb-3">Current State</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-400">Location</dt>
              <dd>{char.locationName ?? 'Unknown'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Health</dt>
              <dd>{char.health ?? 'N/A'}/100</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Fatigue</dt>
              <dd>{char.fatigue ?? 'N/A'}/100</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Wallet</dt>
              <dd>{((char.walletCents ?? 0) / 100).toFixed(2)} gold</dd>
            </div>
          </dl>
        </div>

        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <h3 className="font-semibold mb-3">Personality</h3>
          <div className="space-y-2">
            {traits.map((t) => (
              <div key={t.trait} className="flex items-center gap-2">
                <span className="text-sm text-gray-300 w-24 capitalize">{t.trait}</span>
                <div className="flex-1 bg-gray-700 rounded-full h-2">
                  <div
                    className="bg-amber-500 rounded-full h-2"
                    style={{ width: `${t.weight * 100}%` }}
                  />
                </div>
                <span className="text-xs text-gray-400">{Math.round(t.weight * 100)}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
        <h3 className="font-semibold mb-2">Background</h3>
        <p className="text-gray-300 text-sm">{char.background}</p>
        {skills.length > 0 && (
          <div className="mt-3">
            <span className="text-xs text-gray-400 uppercase tracking-wide">Skills</span>
            <div className="flex flex-wrap gap-2 mt-1">
              {skills.map((s) => (
                <span key={s} className="text-xs bg-gray-800 px-2 py-1 rounded">{s}</span>
              ))}
            </div>
          </div>
        )}
      </div>

      <DirectiveForm characterId={params.id} />

      {directiveHistory.length > 0 && (
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <h3 className="font-semibold mb-3">Directive History</h3>
          <div className="space-y-2">
            {directiveHistory.map((d: Directive) => (
              <div key={d.id} className={`text-sm p-2 rounded ${d.active ? 'bg-amber-900/30 border border-amber-700' : 'bg-gray-800'}`}>
                <div className="flex justify-between items-start mb-1">
                  <span className="text-xs text-gray-400">
                    {new Date(d.submittedAt).toLocaleString()}
                  </span>
                  {d.active && <span className="text-xs text-amber-400">Active</span>}
                </div>
                <p className="text-gray-200">{d.text}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {recentDecisions.length > 0 && (
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <h3 className="font-semibold mb-3">Recent Decisions</h3>
          <div className="space-y-2">
            {recentDecisions.map((d: Decision) => (
              <div key={d.id} className="text-sm flex items-center gap-3 py-1 border-b border-gray-800 last:border-0">
                <span className="font-mono text-amber-400">{d.chosenAction}</span>
                <span className="text-gray-400 text-xs">{new Date(d.createdAt).toLocaleTimeString()}</span>
                <span className="text-gray-500 text-xs">{d.latencyMs}ms</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
