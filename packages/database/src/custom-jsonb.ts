import { customType } from 'drizzle-orm/pg-core';

/**
 * Drop-in replacement for drizzle-orm 0.31.x's built-in `jsonb()`
 * column type, which double-encodes every value when paired with the
 * `postgres` driver (see docs/architecture.md's "Known issue —
 * jsonb double-encoding" for the full root-cause writeup and the
 * empirical probe that confirmed it). In short:
 *   - drizzle's built-in PgJsonb.mapToDriverValue unconditionally
 *     JSON.stringify()s the value before handing it to postgres.js.
 *   - postgres.js's own jsonb serializer ALSO calls JSON.stringify()
 *     on whatever it receives — string or not — for a jsonb-typed
 *     bind parameter.
 *   - The result: every jsonb column has been storing a JSON STRING
 *     SCALAR containing escaped JSON text, not a real object/array.
 *     Invisible to this app (drizzle's mapFromDriverValue defensively
 *     re-parses strings on the way out), but wrong to any raw-SQL
 *     consumer (psql, `jsonb_typeof()`, a future admin query, an
 *     external BI tool) and a correctness bug in its own right.
 *
 * toDriver is pass-through: postgres.js serializes a raw JS value to
 * jsonb correctly on its own (confirmed empirically — passing the
 * object directly stores real jsonb; passing a pre-stringified value
 * double-encodes). Every NEW write through this column type is
 * correct from here on.
 *
 * fromDriver is NOT a bare pass-through, deliberately: existing rows
 * written before this fix are still double-encoded, and the one-off
 * data migration (fix-jsonb-double-encoding.ts) is a separate,
 * manually-invoked script — not part of `db:migrate`, so a database
 * can easily be running this fixed code against still-corrupted data
 * (e.g. this fix gets deployed before someone remembers to run the
 * migration script). A correctly-stored jsonb value already arrives
 * here as a real object/array/etc. (postgres.js decodes it); only a
 * not-yet-migrated row arrives as a `string`, so parsing exactly
 * mirrors drizzle-orm's own original (if double-applied) defensive
 * behavior — this makes reads self-healing regardless of migration
 * timing, without reintroducing the double-encoding on write that
 * caused the bug in the first place.
 */
export const jsonbColumn = customType<{ data: unknown; driverData: unknown }>({
  dataType() {
    return 'jsonb';
  },
  toDriver(value) {
    return value;
  },
  fromDriver(value) {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      // Not actually double-encoded JSON — a column truly meant to
      // hold a plain string would end up here too. Return as-is
      // rather than throw; every column this type is used for today
      // is documented (schema.ts) to hold an array/object, never a
      // legitimate scalar string, so this branch is not expected to
      // be reachable in practice.
      return value;
    }
  },
});
