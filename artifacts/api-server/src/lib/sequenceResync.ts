import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { withDbRetry } from "./dbRetry";

/**
 * Realign serial-column sequences with their tables' actual max IDs.
 *
 * Why this exists: when Replit's publish flow creates the production database
 * as a copy of development, the copied rows keep their IDs but the owned
 * sequences can be left behind (observed: audit_reports had rows up to id 54
 * while its sequence stood at 39). Every subsequent INSERT then fails with a
 * duplicate-key violation on the primary key. This routine runs once at server
 * startup and is:
 *
 *   - forward-only: it never moves a sequence backwards, so it is a no-op on
 *     a healthy database (dev or prod);
 *   - data-level only: it calls setval(); it performs no DDL and makes no
 *     schema changes (schema stays owned by the publish flow);
 *   - non-fatal: any failure is logged and swallowed so it can never block
 *     server startup.
 */
export async function resyncSerialSequences(): Promise<void> {
  try {
    const owned = await withDbRetry(
      () =>
        db.execute(sql`
          SELECT seq.relname AS seq_name,
                 tbl.relname AS table_name,
                 col.attname AS column_name
          FROM pg_class seq
          JOIN pg_depend dep ON dep.objid = seq.oid AND dep.deptype = 'a'
          JOIN pg_class tbl ON tbl.oid = dep.refobjid
          JOIN pg_attribute col ON col.attrelid = tbl.oid AND col.attnum = dep.refobjsubid
          WHERE seq.relkind = 'S'
            AND seq.relnamespace = 'public'::regnamespace
        `),
      { label: "seq_resync:list" },
    );

    const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    let fixed = 0;

    for (const row of owned.rows as Array<Record<string, unknown>>) {
      const seqName = String(row["seq_name"] ?? "");
      const tableName = String(row["table_name"] ?? "");
      const columnName = String(row["column_name"] ?? "");
      if (!IDENT.test(seqName) || !IDENT.test(tableName) || !IDENT.test(columnName)) {
        logger.warn(
          { seqName, tableName, columnName },
          "Sequence resync: skipping non-standard identifier",
        );
        continue;
      }

      const maxRes = await withDbRetry(
        () =>
          db.execute(
            sql.raw(`SELECT COALESCE(MAX("${columnName}"), 0)::bigint AS max_id FROM "${tableName}"`),
          ),
        { label: `seq_resync:max:${tableName}` },
      );
      const maxId = Number((maxRes.rows[0] as Record<string, unknown> | undefined)?.["max_id"] ?? 0);
      if (!Number.isFinite(maxId) || maxId <= 0) continue;

      // pg_sequences.last_value is NULL when the sequence has never been used.
      const curRes = await withDbRetry(
        () =>
          db.execute(sql`
            SELECT last_value FROM pg_sequences
            WHERE schemaname = 'public' AND sequencename = ${seqName}
          `),
        { label: `seq_resync:cur:${seqName}` },
      );
      const rawCur = (curRes.rows[0] as Record<string, unknown> | undefined)?.["last_value"];
      const cur = rawCur === null || rawCur === undefined ? null : Number(rawCur);

      if (cur === null || maxId > cur) {
        // setval(..., true) means the NEXT nextval() returns maxId + 1.
        await withDbRetry(
          () => db.execute(sql`SELECT setval(${`public."${seqName}"`}::regclass, ${maxId}, true)`),
          { label: `seq_resync:set:${seqName}` },
        );
        fixed++;
        logger.warn(
          { seqName, tableName, from: cur, to: maxId },
          "Sequence resync: advanced lagging sequence",
        );
      }
    }

    logger.info(
      { checked: owned.rows.length, fixed },
      "Sequence resync: complete",
    );
  } catch (err) {
    logger.error({ err }, "Sequence resync: failed (non-fatal, continuing startup)");
  }
}
