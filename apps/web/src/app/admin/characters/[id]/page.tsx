import { requireAdminPageSession } from '@/lib/admin';
import { getDb } from '@/lib/db';
import { schema } from '@ai-world/database';
import { eq, desc, or, inArray, sql, and } from 'drizzle-orm';
import { CharacterAvatar } from '@/components/CharacterAvatar';

export const dynamic = 'force-dynamic';

interface CharacterHeader {
  id: string;
  name: string;
  archetype: string;
  background: string;
  locationName: string | null;
  status: string | null;
  walletCents: number | null;
}

interface DecisionRow {
  decisionId: string;
  contextSummary: unknown;
  model: string;
  chosenAction: string;
  targetId: string | null;
  latencyMs: number | null;
  decisionCreatedAt: Date;
  actionPayload: unknown;
  validationResult: string | null;
}

interface CostRow {
  purpose: string;
  totalCents: number;
  callCount: number;
}

type RelationshipRow = typeof schema.relationships.$inferSelect & {
  otherCharacterId: string;
  otherCharacterName: string;
};

type MemoryRow = typeof schema.memories.$inferSelect;
type GameEventRow = typeof schema.gameEvents.$inferSelect;

async function getCharacter(id: string): Promise<CharacterHeader | undefined> {
  const [char] = await getDb()
    .select({
      id: schema.characters.id,
      name: schema.characters.name,
      archetype: schema.characters.archetype,
      background: schema.characters.background,
      locationName: schema.locations.name,
      status: schema.characterState.status,
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

/**
 * The core "why did this character do that" query (§13). One row per
 * decision, left-joined to its resulting action so the model's stated
 * intent/goal AND the deterministic engine's verdict (valid/rejected/
 * fallback, with a reason on rejection) sit side by side — this is
 * the whole answer, no further clicking required.
 */
async function getDecisionHistory(characterId: string): Promise<DecisionRow[]> {
  return getDb()
    .select({
      decisionId: schema.agentDecisions.id,
      contextSummary: schema.agentDecisions.contextSummary,
      model: schema.agentDecisions.model,
      chosenAction: schema.agentDecisions.chosenAction,
      targetId: schema.agentDecisions.targetId,
      latencyMs: schema.agentDecisions.latencyMs,
      decisionCreatedAt: schema.agentDecisions.createdAt,
      actionPayload: schema.agentActions.payload,
      validationResult: schema.agentActions.validationResult,
    })
    .from(schema.agentDecisions)
    .leftJoin(schema.agentActions, eq(schema.agentActions.decisionId, schema.agentDecisions.id))
    .where(eq(schema.agentDecisions.characterId, characterId))
    .orderBy(desc(schema.agentDecisions.createdAt))
    .limit(30);
}

async function getCostBreakdown(characterId: string): Promise<CostRow[]> {
  return getDb()
    .select({
      purpose: schema.aiUsage.purpose,
      totalCents: sql<number>`coalesce(sum(${schema.aiUsage.estimatedCostCents}), 0)::real`,
      callCount: sql<number>`count(*)::int`,
    })
    .from(schema.aiUsage)
    .where(eq(schema.aiUsage.characterId, characterId))
    .groupBy(schema.aiUsage.purpose);
}

async function getRelationships(characterId: string): Promise<RelationshipRow[]> {
  const rows: (typeof schema.relationships.$inferSelect)[] = await getDb()
    .select()
    .from(schema.relationships)
    .where(or(eq(schema.relationships.characterAId, characterId), eq(schema.relationships.characterBId, characterId)))
    .orderBy(desc(schema.relationships.updatedAt))
    .limit(10);

  const otherIds = rows.map((r) => (r.characterAId === characterId ? r.characterBId : r.characterAId));
  const otherNames: Array<{ id: string; name: string }> =
    otherIds.length > 0
      ? await getDb()
          .select({ id: schema.characters.id, name: schema.characters.name })
          .from(schema.characters)
          .where(inArray(schema.characters.id, otherIds))
      : [];
  const nameById = new Map<string, string>(otherNames.map((c) => [c.id, c.name]));

  return rows.map((r) => ({
    ...r,
    otherCharacterId: r.characterAId === characterId ? r.characterBId : r.characterAId,
    otherCharacterName: nameById.get(r.characterAId === characterId ? r.characterBId : r.characterAId) ?? 'Unknown',
  }));
}

async function getRecentMemories(characterId: string): Promise<MemoryRow[]> {
  return getDb()
    .select()
    .from(schema.memories)
    .where(eq(schema.memories.characterId, characterId))
    .orderBy(desc(schema.memories.createdAt))
    .limit(10);
}

// agent_actions.payload never carries a rejection reason (it's the
// same {intent, goal, parameters, ...} shape whether the action was
// valid or not) — the reason lives on the separate ACTION_REJECTED
// game_events row the tick loop writes instead. No direct FK ties an
// action to its event, so this is queried and shown separately rather
// than pretending they're joinable.
async function getRecentRejections(characterId: string): Promise<GameEventRow[]> {
  return getDb()
    .select()
    .from(schema.gameEvents)
    .where(and(eq(schema.gameEvents.actorCharacterId, characterId), eq(schema.gameEvents.type, 'ACTION_REJECTED')))
    .orderBy(desc(schema.gameEvents.createdAt))
    .limit(10);
}

function relationshipBar(label: string, value: number) {
  // -100..100 -> 0..100% width, centered
  const pct = ((value + 100) / 200) * 100;
  const positive = value >= 0;
  return (
    <div key={label} className="flex items-center gap-2 text-xs">
      <span className="w-16 text-gray-400 capitalize">{label}</span>
      <div className="flex-1 bg-gray-700 rounded-full h-1.5 relative">
        <div
          className={`absolute top-0 h-1.5 rounded-full ${positive ? 'bg-green-500' : 'bg-red-500'}`}
          style={{
            left: positive ? '50%' : `${pct}%`,
            width: `${Math.abs(pct - 50)}%`,
          }}
        />
      </div>
      <span className="w-8 text-right text-gray-500">{value}</span>
    </div>
  );
}

export default async function AdminCharacterDetailPage({ params }: { params: { id: string } }) {
  await requireAdminPageSession();

  const [char, decisions, costBreakdown, relationships, recentMemories, recentRejections] = await Promise.all([
    getCharacter(params.id),
    getDecisionHistory(params.id),
    getCostBreakdown(params.id),
    getRelationships(params.id),
    getRecentMemories(params.id),
    getRecentRejections(params.id),
  ]);

  if (!char) {
    return <div className="text-red-400">Character not found</div>;
  }

  const totalCostCents = costBreakdown.reduce((sum, row) => sum + row.totalCents, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <CharacterAvatar seed={char.id} size={64} className="shrink-0 rounded-full bg-gray-800" />
        <div>
          <h2 className="text-2xl font-bold">{char.name}</h2>
          <p className="text-gray-500 text-sm">
            {char.archetype} · {char.locationName ?? 'unknown location'} · {char.status ?? 'unknown'} ·{' '}
            {((char.walletCents ?? 0) / 100).toFixed(2)} gold
          </p>
        </div>
        <a href="/admin" className="ml-auto text-sm text-gray-500 hover:text-gray-300">
          ← back to admin
        </a>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <h3 className="font-semibold mb-3">AI Cost — this character</h3>
          {costBreakdown.length === 0 ? (
            <p className="text-gray-500 text-sm">No AI calls recorded yet.</p>
          ) : (
            <dl className="space-y-2 text-sm">
              {costBreakdown.map((row) => (
                <div key={row.purpose} className="flex justify-between">
                  <dt className="text-gray-400">
                    {row.purpose} <span className="text-gray-600">({row.callCount})</span>
                  </dt>
                  <dd>${(row.totalCents / 100).toFixed(4)}</dd>
                </div>
              ))}
              <div className="flex justify-between pt-2 border-t border-gray-800 font-semibold">
                <dt>Total</dt>
                <dd>${(totalCostCents / 100).toFixed(4)}</dd>
              </div>
            </dl>
          )}
        </div>

        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <h3 className="font-semibold mb-3">Relationships</h3>
          {relationships.length === 0 ? (
            <p className="text-gray-500 text-sm">No relationships formed yet.</p>
          ) : (
            <div className="space-y-3">
              {relationships.map((r) => (
                <div key={r.id} className="space-y-1">
                  <div className="text-sm text-amber-300">{r.otherCharacterName}</div>
                  {relationshipBar('trust', r.trust)}
                  {relationshipBar('affection', r.affection)}
                  {relationshipBar('familiarity', r.familiarity)}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {recentMemories.length > 0 && (
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <h3 className="font-semibold mb-3">Recent Memories</h3>
          <div className="space-y-1">
            {recentMemories.map((m) => (
              <div key={m.id} className="text-sm text-gray-300 flex justify-between gap-3">
                <span className="truncate">{m.content}</span>
                <span className="text-gray-600 text-xs shrink-0">{m.kind}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {recentRejections.length > 0 && (
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <h3 className="font-semibold mb-3">Recent Rejected Actions</h3>
          <div className="space-y-1">
            {recentRejections.map((e) => {
              const payload = (e.payload ?? {}) as Record<string, unknown>;
              return (
                <div key={e.id} className="text-sm flex justify-between gap-3">
                  <span className="text-gray-300">
                    <span className="font-mono text-red-400">{String(payload.action ?? '?')}</span> —{' '}
                    {String(payload.reason ?? 'no reason recorded')}
                  </span>
                  <span className="text-gray-600 text-xs shrink-0">
                    {new Date(e.createdAt).toLocaleTimeString()}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
        <h3 className="font-semibold mb-3">Decision History — why did this character do that?</h3>
        {decisions.length === 0 ? (
          <p className="text-gray-500 text-sm">No decisions recorded yet.</p>
        ) : (
          <div className="space-y-2">
            {decisions.map((d) => {
              const payload = (d.actionPayload ?? {}) as Record<string, unknown>;
              return (
                <div key={d.decisionId} className="text-sm p-3 rounded bg-gray-800">
                  <div className="flex items-center justify-between gap-3 mb-1">
                    <span className="font-mono text-amber-400">
                      {d.chosenAction}
                      {d.targetId ? <span className="text-gray-500"> → {d.targetId.slice(0, 8)}</span> : null}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          d.validationResult === 'valid'
                            ? 'bg-green-900 text-green-300'
                            : d.validationResult === 'fallback'
                            ? 'bg-amber-900 text-amber-300'
                            : 'bg-red-900 text-red-300'
                        }`}
                      >
                        {d.validationResult ?? 'unknown'}
                      </span>
                      <span className="text-gray-600 text-xs">{d.model}</span>
                      <span className="text-gray-600 text-xs">{d.latencyMs}ms</span>
                    </div>
                  </div>
                  {typeof payload.intent === 'string' && (
                    <p className="text-gray-300">
                      <span className="text-gray-500">intent:</span> {payload.intent}
                    </p>
                  )}
                  {typeof payload.goal === 'string' && (
                    <p className="text-gray-400">
                      <span className="text-gray-500">goal:</span> {payload.goal}
                    </p>
                  )}
                  <p className="text-gray-600 text-xs mt-1">
                    {new Date(d.decisionCreatedAt).toLocaleString()}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
