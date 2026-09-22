import { z } from 'zod';

import type { HistoryIndexPort, HistorySummary } from './history-port.js';

// The raw statement runner of the coordinator's transaction, narrowed so
// this module needs nothing from the port that embeds it.
export type RawClient = {
  readonly raw: (
    sql: string,
    bindings?: Array<boolean | null | number | string>,
  ) => PromiseLike<unknown>;
};

// Every statement binds its values as JSON or plain numbers; none carries
// an identifier from the caller. The entry columns are the model's: `label` (unique,
// exact text) and `review_state`.

// Bindings: labels JSON.
export const entriesSql = `SELECT "id", "label" FROM "moodle_course_entries"
WHERE "label" IN (SELECT "value" FROM json_array_elements_text(?::json)) ORDER BY "id"`;

// Bindings: labels JSON. A label created by hand in the same instant is
// skipped by the conflict clause and found by the lookup that follows.
export const entryInsertSql = `INSERT INTO "moodle_course_entries" ("label", "review_state")
SELECT wanted."value", 'needs_mapping' FROM json_array_elements_text(?::json) AS wanted
ON CONFLICT ("label") DO NOTHING`;

// Bindings: user ids JSON.
export const membershipDeleteSql = `DELETE FROM "moodle_history_memberships"
WHERE "moodle_user" IN (SELECT "value"::integer FROM json_array_elements_text(?::json))`;

// Bindings: rows JSON.
export const membershipInsertSql = `INSERT INTO "moodle_history_memberships" ("moodle_user", "entry", "sort")
SELECT rows."moodle_user", rows."entry", rows."sort"
FROM json_to_recordset(?::json) AS rows("moodle_user" integer, "entry" integer, "sort" integer)`;

// Transaction-local: the setting ends with the writer's transaction, so a
// pooled connection never carries it into another statement.
export const openWriterSql = `SELECT set_config('finki_hub.history_writer', 'on', true)`;

// Bindings: first id, last id.
export const userIdsSql = `SELECT "id" FROM "moodle_users" WHERE "id" BETWEEN ? AND ? ORDER BY "id"`;

// The raw scraper field `Courses Count` is compared, never written.
export const summarySql = `SELECT
  (SELECT COUNT(*)::integer FROM "moodle_users") AS "users",
  (SELECT COUNT(DISTINCT "moodle_user")::integer FROM "moodle_history_memberships") AS "indexed_users",
  (SELECT COUNT(*)::integer FROM "moodle_history_memberships") AS "memberships",
  (SELECT COUNT(*)::integer FROM "moodle_course_entries") AS "entries",
  (SELECT COUNT(*)::integer FROM "moodle_course_entries" WHERE "review_state" = 'needs_mapping') AS "needs_mapping",
  (SELECT COUNT(*)::integer FROM "moodle_users" u
    WHERE COALESCE(u."Courses Count", 0) <> (SELECT COUNT(*) FROM "moodle_history_memberships" m WHERE m."moodle_user" = u."id")) AS "count_mismatches"`;

const resultSchema = z.object({
  rowCount: z.number().nullable().optional(),
  rows: z.array(z.unknown()),
});

const count = z.coerce.number().int().nonnegative();

const entryRows = z.array(
  z.object({ id: z.coerce.number().int(), label: z.string() }),
);

const summaryRow = z.object({
  count_mismatches: count,
  entries: count,
  indexed_users: count,
  memberships: count,
  needs_mapping: count,
  users: count,
});

const json = (value: unknown): string => JSON.stringify(value);

const idRows = z.array(z.object({ id: z.coerce.number().int() }));

type Binding = number | string;

const run = async (client: RawClient, sql: string, bindings: Binding[]) =>
  resultSchema.parse(await client.raw(sql, bindings));

const affected = async (
  client: RawClient,
  sql: string,
  bindings: Binding[],
): Promise<number> => {
  const result = await run(client, sql, bindings);
  return result.rowCount ?? 0;
};

const toSummary = (row: z.infer<typeof summaryRow>): HistorySummary => ({
  countMismatches: row.count_mismatches,
  entries: row.entries,
  indexedUsers: row.indexed_users,
  memberships: row.memberships,
  needsMapping: row.needs_mapping,
  users: row.users,
});

export const historySqlPort = (client: RawClient): HistoryIndexPort => ({
  createEntries: (labels) => affected(client, entryInsertSql, [json(labels)]),
  deleteMemberships: (users) =>
    affected(client, membershipDeleteSql, [json(users)]),
  entriesByLabel: async (labels) => {
    const result = await run(client, entriesSql, [json(labels)]);
    return entryRows.parse(result.rows);
  },
  insertMemberships: (rows) =>
    affected(client, membershipInsertSql, [json(rows)]),
  openWriter: async () => {
    await run(client, openWriterSql, []);
  },
  summary: async () => {
    const result = await run(client, summarySql, []);
    const [row] = result.rows;
    return toSummary(summaryRow.parse(row));
  },
  userIdsBetween: async (from, to) => {
    const result = await run(client, userIdsSql, [from, to]);
    return idRows.parse(result.rows).map(({ id }) => id);
  },
});
