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
 * toDriver/fromDriver are both pass-through: postgres.js serializes a
 * raw JS value to jsonb correctly on its own (confirmed empirically —
 * passing the object directly stores real jsonb; passing a
 * pre-stringified value double-encodes), and it already deserializes
 * jsonb columns back to real JS values on the way out (it registers
 * its own wire-format parser for the jsonb OID). There is nothing
 * left for either side of this mapping to do.
 *
 * Existing rows written before this fix are still double-encoded —
 * see fix-jsonb-double-encoding.ts for the one-off data migration.
 */
export const jsonbColumn = customType<{ data: unknown; driverData: unknown }>({
  dataType() {
    return 'jsonb';
  },
  toDriver(value) {
    return value;
  },
  fromDriver(value) {
    return value;
  },
});
