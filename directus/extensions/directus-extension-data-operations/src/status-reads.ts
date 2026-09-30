import { z } from 'zod';

import type { SqlClient } from './coordination/sql-port.js';
import type { SourceReader } from './exports/engine.js';
import type { KeySource, KeySourceName } from './exports/types.js';
import type { KeySourceView } from './status-contract.js';
import type { ScheduledRun } from './status-view.js';

import { keySources, optInField } from './exports/key-sources.js';
import {
  collectionPage,
  humanize,
  itemPage,
  scheduleLookBackMinutes,
} from './managed-flows.js';

// The bounded reads of the status endpoint beside the coordinator status:
// the rows of every key source, the last run of each scheduled Flow, the
// ids of the review bookmarks and whether a caller holds the editor
// policy. Every statement binds its values; none takes an identifier from
// a caller.

// The last run of a scheduled Flow is looked up within
// scheduleLookBackMinutes (managed-flows.ts): the activity table has an
// index on its timestamp, so the window keeps the read to the rows of the
// last hour however large the table has grown. Timestamps are ISO-8601
// strings rendered by the database.

const scheduleSql = `SELECT f."id", f."name", f."status",
  to_char(runs."last" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "last_run",
  FLOOR(EXTRACT(EPOCH FROM clock_timestamp() - runs."last"))::integer AS "age_seconds"
FROM "directus_flows" f
LEFT JOIN LATERAL (SELECT MAX(a."timestamp") AS "last" FROM "directus_activity" a
  WHERE a."timestamp" > NOW() - make_interval(mins => ?)
    AND a."collection" = 'directus_flows' AND a."action" = 'run'
    AND a."item" = f."id"::text) runs ON TRUE
WHERE f."trigger" = 'schedule' ORDER BY f."name", f."id"`;

// Bindings: bookmark names JSON.
const bookmarksSql = `SELECT "id", "collection", "bookmark" FROM "directus_presets"
WHERE "user" IS NULL AND "role" IS NULL
  AND "bookmark" IN (SELECT "value" FROM json_array_elements_text(?::json))
ORDER BY "id"`;

// Bindings: policy id, user id (or null), role ids JSON.
const holdsPolicySql = `SELECT COUNT(*)::integer AS "count" FROM "directus_access"
WHERE "policy" = ?::uuid
  AND ("user" = ?::uuid OR "role" IN (SELECT "value"::uuid FROM json_array_elements_text(?::json)))`;

const resultRows = <Row extends z.ZodType>(row: Row) =>
  z.object({ rows: z.array(row) });

const scheduleRow = z.object({
  age_seconds: z.number().int().nullable(),
  id: z.string(),
  last_run: z.string().nullable(),
  name: z.string(),
  status: z.string(),
});

const bookmarkRow = z.object({
  bookmark: z.string(),
  collection: z.string(),
  id: z.coerce.number().int(),
});

const countRow = z.object({ count: z.coerce.number().int().nonnegative() });

export const readSchedule = async (sql: SqlClient): Promise<ScheduledRun[]> => {
  const { rows } = resultRows(scheduleRow).parse(
    await sql.raw(scheduleSql, [scheduleLookBackMinutes]),
  );
  return rows.map((row) => ({
    active: row.status === 'active',
    ageSeconds: row.age_seconds,
    id: row.id,
    lastRunAt: row.last_run,
    name: row.name,
  }));
};

// The key of a bookmark in the map readBookmarks answers.
export const bookmarkKey = (collection: string, bookmark: string): string =>
  `${collection}\u{0}${bookmark}`;

// The id of each global bookmark of these names, by collection and name
// (the oldest when two share both).
export const readBookmarks = async (
  sql: SqlClient,
  names: readonly string[],
): Promise<ReadonlyMap<string, number>> => {
  if (names.length === 0) {
    return new Map();
  }
  const { rows } = resultRows(bookmarkRow).parse(
    await sql.raw(bookmarksSql, [JSON.stringify(names)]),
  );
  const found = new Map<string, number>();
  for (const { bookmark, collection, id } of rows) {
    const key = bookmarkKey(collection, bookmark);
    if (!found.has(key)) {
      found.set(key, id);
    }
  }
  return found;
};

// Whether the user, or a role of the caller's role tree, holds the policy.
export const holdsPolicy = async (
  sql: SqlClient,
  policy: string,
  caller: { readonly roles: readonly string[]; readonly user: null | string },
): Promise<boolean> => {
  const { rows } = resultRows(countRow).parse(
    await sql.raw(holdsPolicySql, [
      policy,
      caller.user,
      JSON.stringify(caller.roles),
    ]),
  );
  return (rows[0]?.count ?? 0) > 0;
};

const keyRows = z.array(
  z.looseObject({ id: z.union([z.number().int(), z.string()]) }),
);

const keyText = (value: unknown): null | string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : null;

// One key source: every row with its key text and flag, and which rows
// place keys now (the source's own filter, which may also require a
// published parent).
const readKeySource = async (
  reader: SourceReader,
  name: string,
  source: KeySource,
): Promise<KeySourceView> => {
  const { collection, key } = source;
  const rows = keyRows.parse(
    await reader({
      collection,
      fields: ['id', key, optInField],
      sort: [...source.sort],
    }),
  );
  const placing = new Set(
    keyRows
      .parse(
        await reader({
          collection,
          fields: ['id'],
          ...(source.filter !== undefined && { filter: source.filter }),
          sort: [],
        }),
      )
      .map(({ id }) => String(id)),
  );
  return {
    collection,
    key,
    label: humanize(collection),
    link: collectionPage(collection),
    name,
    rows: rows.map((row) => ({
      id: row.id,
      key: keyText(row[key]),
      link: itemPage(collection, row.id),
      placesKeys: placing.has(String(row.id)),
      published: row[optInField] === true,
    })),
  };
};

// Every declared key source, in declaration order.
export const readKeySources = async (
  reader: SourceReader,
  sources: Readonly<Partial<Record<KeySourceName, KeySource>>> = keySources,
): Promise<KeySourceView[]> => {
  const views: KeySourceView[] = [];
  for (const [name, source] of Object.entries(sources)) {
    views.push(await readKeySource(reader, name, source));
  }
  return views;
};
