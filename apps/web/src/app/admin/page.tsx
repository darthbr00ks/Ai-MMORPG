import { requireAdminPageSession } from '@/lib/admin';
import { getDb } from '@/lib/db';
import { schema, getWorldEpoch, getOrCreateSimulationControl } from '@ai-world/database';
import { gameTimeNow, loadConfig } from '@ai-world/shared';
import { desc, eq, gte, sql } from 'drizzle-orm';
import SimulationControls from '@/components/SimulationControls';

export const dynamic = 'force-dynamic';

interface CostByPurposeRow {
  purpose: string;
  totalCents: number;
  callCount: number;
}

interface ModerationRow {
  id: string;
  outcome: string;
  reasonCategory: string;
  createdAt: Date;
  directiveText: string | null;
  characterName: string | null;
  characterId: string | null;
}

interface CharacterSummaryRow {
  id: string;
  name: string;
  archetype: string;
  status: string | null;
}

interface OverviewData {
  gameTime: ReturnType<typeof gameTimeNow>;
  control: Awaited<ReturnType<typeof getOrCreateSimulationControl>>;
  characterCount: number;
  eventCountLast24h: number;
  costByPurpose: CostByPurposeRow[];
  walletTotalCents: number;
  transactionCount: number;
  recentModeration: ModerationRow[];
  characters: CharacterSummaryRow[];
  aiUseLive: boolean;
}

async function getOverviewData(): Promise<OverviewData> {
  const db = getDb();
  const config = loadConfig();

  const epoch = await getWorldEpoch(db);
  const gameTime = gameTimeNow(epoch, config.GAME_DAY_REAL_SECONDS);
  const control = await getOrCreateSimulationControl(db);

  const [characterCountRow] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.characters);

  const todayStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [eventCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.gameEvents)
    .where(gte(schema.gameEvents.createdAt, todayStart));

  const costByPurpose = await db
    .select({
      purpose: schema.aiUsage.purpose,
      totalCents: sql<number>`coalesce(sum(${schema.aiUsage.estimatedCostCents}), 0)::real`,
      callCount: sql<number>`count(*)::int`,
    })
    .from(schema.aiUsage)
    .groupBy(schema.aiUsage.purpose)
    .orderBy(desc(sql`sum(${schema.aiUsage.estimatedCostCents})`));

  const [walletTotalRow] = await db
    .select({ totalCents: sql<number>`coalesce(sum(${schema.wallets.balanceCents}), 0)::int` })
    .from(schema.wallets);

  const [transactionCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.transactions);

  const recentModeration = await db
    .select({
      id: schema.moderationRecords.id,
      outcome: schema.moderationRecords.outcome,
      reasonCategory: schema.moderationRecords.reasonCategory,
      createdAt: schema.moderationRecords.createdAt,
      directiveText: schema.directives.text,
      characterName: schema.characters.name,
      characterId: schema.characters.id,
    })
    .from(schema.moderationRecords)
    .leftJoin(schema.directives, eq(schema.moderationRecords.directiveId, schema.directives.id))
    .leftJoin(schema.characters, eq(schema.directives.characterId, schema.characters.id))
    .orderBy(desc(schema.moderationRecords.createdAt))
    .limit(10);

  const characters = await db
    .select({
      id: schema.characters.id,
      name: schema.characters.name,
      archetype: schema.characters.archetype,
      status: schema.characterState.status,
    })
    .from(schema.characters)
    .leftJoin(schema.characterState, eq(schema.characters.id, schema.characterState.characterId))
    .orderBy(schema.characters.name);

  return {
    gameTime,
    control,
    characterCount: characterCountRow?.count ?? 0,
    eventCountLast24h: eventCountRow?.count ?? 0,
    costByPurpose,
    walletTotalCents: walletTotalRow?.totalCents ?? 0,
    transactionCount: transactionCountRow?.count ?? 0,
    recentModeration,
    characters,
    aiUseLive: config.AI_USE_LIVE,
  };
}

export default async function AdminPage() {
  await requireAdminPageSession();
  const data = await getOverviewData();

  const totalCostCents = data.costByPurpose.reduce((sum, row) => sum + row.totalCents, 0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Admin Console</h2>
        <p className="text-gray-500 text-sm">Simulation status, cost, and moderation — click a character below for why it did what it did.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <SimulationControls initialControl={data.control} />

        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <h3 className="font-semibold mb-3">World Status</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-400">Game day</dt>
              <dd>{data.gameTime.day}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Day progress</dt>
              <dd>{Math.round(data.gameTime.progressFraction * 100)}%</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">AI provider</dt>
              <dd>{data.aiUseLive ? 'Anthropic (live)' : 'Mock (free)'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Characters</dt>
              <dd>{data.characterCount}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Events (last 24h)</dt>
              <dd>{data.eventCountLast24h}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <h3 className="font-semibold mb-3">AI Cost (§8)</h3>
          <dl className="space-y-2 text-sm">
            {data.costByPurpose.map((row) => (
              <div key={row.purpose} className="flex justify-between">
                <dt className="text-gray-400">
                  {row.purpose} <span className="text-gray-600">({row.callCount} calls)</span>
                </dt>
                <dd>${(row.totalCents / 100).toFixed(4)}</dd>
              </div>
            ))}
            <div className="flex justify-between pt-2 border-t border-gray-800 font-semibold">
              <dt>Total</dt>
              <dd>${(totalCostCents / 100).toFixed(4)}</dd>
            </div>
          </dl>
        </div>

        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <h3 className="font-semibold mb-3">Economy</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-400">Total wallet balance</dt>
              <dd>{(data.walletTotalCents / 100).toFixed(2)} gold</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Ledger entries</dt>
              <dd>{data.transactionCount}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
        <h3 className="font-semibold mb-3">Moderation Queue (recent)</h3>
        {data.recentModeration.length === 0 ? (
          <p className="text-gray-500 text-sm">No directives moderated yet.</p>
        ) : (
          <div className="space-y-2">
            {data.recentModeration.map((m) => (
              <div key={m.id} className="text-sm p-2 rounded bg-gray-800 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {m.characterId ? (
                    <a href={`/admin/characters/${m.characterId}`} className="text-amber-300 hover:text-amber-200">
                      {m.characterName}
                    </a>
                  ) : (
                    <span className="text-gray-400">Unknown character</span>
                  )}
                  <p className="text-gray-400 truncate">{m.directiveText}</p>
                </div>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${
                    m.outcome === 'accepted'
                      ? 'bg-green-900 text-green-300'
                      : m.outcome === 'flagged'
                      ? 'bg-amber-900 text-amber-300'
                      : 'bg-red-900 text-red-300'
                  }`}
                >
                  {m.outcome}
                  {m.reasonCategory ? `: ${m.reasonCategory}` : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
        <h3 className="font-semibold mb-3">Characters — click for decision history &amp; cost</h3>
        <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
          {data.characters.map((c) => (
            <a
              key={c.id}
              href={`/admin/characters/${c.id}`}
              className="block bg-gray-800 rounded p-2 border border-gray-800 hover:border-gray-600 text-sm"
            >
              <div className="font-medium">{c.name}</div>
              <div className="text-gray-500 text-xs">{c.archetype} · {c.status ?? 'unknown'}</div>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
