import postgres from 'postgres';
import { loadRootEnv } from '@ai-world/shared';

// A plain Node script (unlike apps/web) — load the repo-root .env
// before reading process.env.DATABASE_URL below.
loadRootEnv(process.cwd());

/**
 * One-off data migration for the jsonb double-encoding bug (see
 * custom-jsonb.ts and docs/architecture.md's "Known issue" section).
 * The write path is fixed (schema.ts now uses jsonbColumn instead of
 * drizzle-orm's built-in jsonb()) — this script repairs rows written
 * BEFORE that fix, which are still stored as a JSON string scalar
 * (`jsonb_typeof() = 'string'`) instead of the real object/array they
 * should be.
 *
 * Every jsonb column in this schema is meant to hold an array or an
 * object — none of them has a legitimate scalar-string value — so
 * `jsonb_typeof(col) = 'string'` is unconditional evidence of the bug
 * for every column this touches, never a false positive.
 *
 * Unwraps one layer of encoding at a time
 * (`(col #>> '{}')::jsonb` — extract the scalar's text content, then
 * re-parse it as jsonb) and repeats per column until either it's no
 * longer a string or a safety cap is hit, so a hypothetical
 * multiply-encoded row (never observed, but cheap to guard against)
 * gets fully repaired rather than left one layer deep. Idempotent —
 * safe to run again; a column with no double-encoded rows left is a
 * no-op.
 */

const JSONB_COLUMNS: Array<{ table: string; column: string }> = [
  { table: 'locations', column: 'connections' },
  { table: 'characters', column: 'appearance_json' },
  { table: 'characters', column: 'personality_traits' },
  { table: 'characters', column: 'skills' },
  { table: 'characters', column: 'ambitions' },
  { table: 'agent_decisions', column: 'context_summary' },
  { table: 'agent_actions', column: 'payload' },
  { table: 'game_events', column: 'payload' },
  { table: 'conversations', column: 'participant_ids' },
  { table: 'audit_log', column: 'payload' },
];

const MAX_UNWRAP_PASSES = 5;

async function fixJsonbDoubleEncoding() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');

  const sql = postgres(url, { max: 1 });

  let totalRowsFixed = 0;

  for (const { table, column } of JSONB_COLUMNS) {
    let passRowsFixed = 0;
    for (let pass = 0; pass < MAX_UNWRAP_PASSES; pass++) {
      const result = await sql`
        UPDATE ${sql(table)}
        SET ${sql(column)} = (${sql(column)} #>> '{}')::jsonb
        WHERE jsonb_typeof(${sql(column)}) = 'string'
      `;
      if (result.count === 0) break;
      passRowsFixed += result.count;
      console.log(`  ${table}.${column}: unwrapped ${result.count} row(s) (pass ${pass + 1})`);
    }
    totalRowsFixed += passRowsFixed;
    if (passRowsFixed === 0) {
      console.log(`  ${table}.${column}: already clean`);
    }
  }

  console.log(`\nDone — ${totalRowsFixed} row-column values repaired.`);

  // Verify: nothing double-encoded should remain.
  let remaining = 0;
  for (const { table, column } of JSONB_COLUMNS) {
    const [{ count }] = await sql`
      SELECT count(*)::int AS count FROM ${sql(table)} WHERE jsonb_typeof(${sql(column)}) = 'string'
    `;
    remaining += count;
  }
  if (remaining > 0) {
    console.error(`WARNING: ${remaining} row-column value(s) still double-encoded after ${MAX_UNWRAP_PASSES} passes.`);
    process.exitCode = 1;
  } else {
    console.log('Verified: zero remaining double-encoded jsonb values across all tracked columns.');
  }

  await sql.end();
}

fixJsonbDoubleEncoding().catch((err) => {
  console.error('fix-jsonb-double-encoding failed:', err);
  process.exit(1);
});
