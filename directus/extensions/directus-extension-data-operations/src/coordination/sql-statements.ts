import { countedLineSources } from '../enrollment-lines.js';
import { calculationDomains } from './domains.js';
import { neutralActions } from './fingerprint.js';
import {
  claimClear,
  claimInputRevision,
  columns,
  dirtyUnion,
} from './sql-state.js';

// Every statement below binds its values with `?`; none of them carries a
// caller-supplied identifier. SET expressions read the row as it was
// before the update, which is what lets a release copy the claim columns
// into the failure columns while clearing them in the same statement.

export const stateSql = (lock: boolean): string =>
  `SELECT ${columns} FROM "data_operations" ORDER BY "id" LIMIT 1${lock ? ' FOR UPDATE' : ''}`;

// A list of fixed identifiers (declared domains and actions, never a
// caller's value) as SQL string literals.
const literals = (values: readonly string[]): string =>
  values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', ');

const action = `o."options"->>'action'`;

// The managed Flow graph, by what its coordinate steps do (graphKindsOf in
// fingerprint.ts is the same rule): a Flow holding a coordinate step whose
// action is not mark, status, heartbeat, complete or fail (a claim, a page
// step, or a templated or unknown action) roots the calculation graph. The graph adds every Flow its roots reach through Trigger Flow operations, each of which
// names its child by a fixed id; UNION stops at Flows already reached, so
// a cycle ends, and a templated or unknown child id matches no Flow. Only
// system tables are read, never a collection. Binding: the coordinate
// type.
export const graphSql = `WITH RECURSIVE "roots"("graph", "flow") AS (
  SELECT DISTINCT 'calculation', o."flow"::text FROM "directus_operations" o
  WHERE o."type" = ? AND (${action} IS NULL OR ${action} NOT IN (${literals(neutralActions)}))
), "managed"("graph", "flow") AS (
  SELECT "graph", "flow" FROM "roots"
  UNION
  SELECT m."graph", o."options"->>'flow' FROM "directus_operations" o JOIN "managed" m ON o."flow"::text = m."flow"
  WHERE o."type" = 'trigger' AND o."options"->>'flow' IS NOT NULL
)
SELECT m."graph", f."id" AS "flow", f."trigger", f."options" AS "flow_options", f."operation" AS "entry",
  o."id" AS "operation", o."key", o."type", o."options", o."resolve", o."reject"
FROM "managed" m JOIN "directus_flows" f ON f."id"::text = m."flow"
LEFT JOIN "directus_operations" o ON o."flow" = f."id"
ORDER BY m."graph", f."id", o."id"`;

// Bindings: token, owner, domain, fingerprint, dirty JSON, revision.
export const claimSql = `UPDATE "data_operations" SET "claim_token" = ?, "claim_owner" = ?, "claim_domain" = ?,
  "claim_revision" = "source_revision", "claim_fingerprint" = ?, "claim_started_at" = clock_timestamp(),
  "claim_heartbeat_at" = clock_timestamp(), "claim_pages" = NULL, "claim_staged" = '[]'::json,
  "dirty_domains" = ?::json
WHERE "claim_token" IS NULL AND "source_revision" = ?`;

// A failure column set by a release, except for a snapshot promotion's
// claim: the promotion records its own failure in import_state and
// import_error, and must never replace the failure of a work domain, whose
// explicit retry decideClaim demands at the same revision.
const failureColumn = (column: string, value: string): string =>
  `"${column}" = CASE WHEN "claim_domain" = 'snapshot' THEN "${column}" ELSE ${value} END`;

// Bindings: error code, error message, token.
export const releaseSql = `UPDATE "data_operations" SET ${failureColumn('last_error_code', '?')},
  ${failureColumn('last_error_message', '?')}, ${failureColumn('last_error_retries', '"claim_retries"')},
  ${failureColumn('last_error_at', 'clock_timestamp()')}, ${failureColumn('last_failed_revision', '"claim_revision"')},
  ${failureColumn('last_failed_domain', '"claim_domain"')}, ${failureColumn('last_failed_fingerprint', '"claim_fingerprint"')},
  ${claimClear}
WHERE "claim_token" = ?`;

// A live claim's guard: no statement that touched the claimed domain's
// inputs committed since the claim was taken (verifyClaim).
const inputsUnchanged = `${claimInputRevision} <= "claim_revision"`;

// Bindings: dirty JSON, token, owner, claim revision, fingerprint.
export const finishSql = `UPDATE "data_operations" SET "dirty_domains" = ?::json, "completed_revision" = "claim_revision",
  "calculation_fingerprint" = CASE WHEN "claim_domain" IN (${literals(calculationDomains)}) THEN "claim_fingerprint" ELSE "calculation_fingerprint" END,
  "last_run_retries" = "claim_retries", "started_at" = "claim_started_at", "finished_at" = clock_timestamp(), ${claimClear}
WHERE "claim_token" = ? AND "claim_owner" = ? AND "claim_revision" = ?
  AND ${inputsUnchanged} AND "claim_fingerprint" = ?`;

// Bindings: retries, token, owner.
export const retriesSql = `UPDATE "data_operations" SET "claim_retries" = "claim_retries" + ?::integer
WHERE "claim_token" = ? AND "claim_owner" = ?`;

// Bindings: token, owner.
export const heartbeatSql = `UPDATE "data_operations" SET "claim_heartbeat_at" = clock_timestamp()
WHERE "claim_token" = ? AND "claim_owner" = ?`;

// Bindings: page, token, owner. The append happens in SQL under the row
// lock, so parallel pages never lose each other's entries.
export const stagedSql = `UPDATE "data_operations" SET "claim_heartbeat_at" = clock_timestamp(), "claim_staged" = (
  SELECT COALESCE(json_agg(page ORDER BY page), '[]'::json) FROM (
    SELECT DISTINCT page FROM (
      SELECT json_array_elements_text(CASE WHEN json_typeof("claim_staged") = 'array' THEN "claim_staged" ELSE '[]'::json END) AS page
      UNION ALL SELECT ?::text
    ) AS pages
  ) AS staged
) WHERE "claim_token" = ? AND "claim_owner" = ? AND ${inputsUnchanged}`;

// Bindings: planned pages JSON ({ token, from, to, rows } each), token,
// owner.
export const planSql = `UPDATE "data_operations" SET "claim_pages" = ?::json, "claim_staged" = '[]'::json, "claim_heartbeat_at" = clock_timestamp()
WHERE "claim_token" = ? AND "claim_owner" = ? AND ${inputsUnchanged}`;

// A calculation's input revision moves with a statement or mark that
// touches it or an upstream domain, like the trigger function's.
const inputRevisionSet = (column: string): string =>
  `"${column}" = CASE WHEN ?::boolean THEN "source_revision" + 1 ELSE "${column}" END`;

// Bindings: whether the mark touches the history index inputs, the
// enrollment inputs, then the marked domains JSON.
export const markSql = `UPDATE "data_operations" SET "source_revision" = "source_revision" + 1, "requested_revision" = "source_revision" + 1,
  ${inputRevisionSet('history_index_input_revision')}, ${inputRevisionSet('enrollments_input_revision')},
  "dirty_domains" = ${dirtyUnion('?::json')} RETURNING "source_revision", "dirty_domains"`;

// Bindings: the lock wait in milliseconds, for this transaction only.
export const lockWaitSql = `SELECT set_config('lock_timeout', ?, true)`;

const [explicitSource, patternSource] = countedLineSources;

// Bindings: token, page, rows JSON.
export const stageSql = `INSERT INTO "data_operation_matches" ("claim_token", "page_token", "entry", "pattern_mapping", "year_label")
SELECT ?, ?, rows."entry", rows."pattern_mapping", rows."year_label"
FROM json_to_recordset(?::json) AS rows("entry" integer, "pattern_mapping" integer, "year_label" text)`;

// The lines the claim counts, by the rules of resolveLines
// (enrollment-lines.ts): a line with an explicit mapping counts exactly
// for its explicit mappings; any other line counts for every match the
// claim staged, an only-in-year mapping in its year, an all-years mapping
// in the academic year labelled as its year pattern read, unless that
// label names no year or the course has an only-in-year mapping in that
// year. Binding: token.
export const countedLinesSql = `INSERT INTO "moodle_counted_lines" ("entry", "course", "academic_year", "source", "pattern_mapping")
SELECT e."entry", e."course", e."academic_year", '${explicitSource}', NULL FROM "moodle_course_mappings" e
UNION ALL
SELECT m."entry", p."course", COALESCE(p."only_in_year", y."id"), '${patternSource}', p."id"
FROM "data_operation_matches" m
JOIN "moodle_pattern_mappings" p ON p."id" = m."pattern_mapping"
LEFT JOIN "academic_years" y ON p."only_in_year" IS NULL AND y."label" = m."year_label"
WHERE m."claim_token" = ?
  AND NOT EXISTS (SELECT 1 FROM "moodle_course_mappings" x WHERE x."entry" = m."entry")
  AND (p."only_in_year" IS NOT NULL OR (y."id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "moodle_pattern_mappings" o WHERE o."course" = p."course" AND o."only_in_year" = y."id")))
ORDER BY 1, 2, 3, 5`;

// One count row per course and academic year: the distinct Moodle users
// holding a line counted for that pair, 0 when none does. Binding:
// revision.
export const enrollmentsSql = `INSERT INTO "course_enrollments" ("course", "academic_year", "count", "computed_revision", "computed_at")
SELECT c."id", y."id", COUNT(DISTINCT h."moodle_user")::integer, ?, clock_timestamp()
FROM "courses" c CROSS JOIN "academic_years" y
LEFT JOIN "moodle_counted_lines" l ON l."course" = c."id" AND l."academic_year" = y."id"
LEFT JOIN "moodle_history_memberships" h ON h."entry" = l."entry"
GROUP BY c."id", y."id" ORDER BY c."id", y."id"`;
