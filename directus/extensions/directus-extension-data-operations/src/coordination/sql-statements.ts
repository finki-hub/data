import {
  claimClear,
  claimInputRevision,
  columns,
  dirtyUnion,
} from './sql-state.js';
import { publishedFiles } from './state.js';

// Every statement below binds its values with `?`; none of them carries a
// caller-supplied identifier. SET expressions read the row as it was
// before the update, which is what lets a release copy the claim columns
// into the failure columns while clearing them in the same statement.

export const stateSql = (lock: boolean): string =>
  `SELECT ${columns} FROM "data_operations" ORDER BY "id" LIMIT 1${lock ? ' FOR UPDATE' : ''}`;

// The managed Flow graph: every Flow holding a coordinate operation, and
// every Flow reachable from one of those through Trigger Flow operations
// (a child that computes without a coordinate step of its own still
// shapes the output). UNION stops at Flows already reached, so a cycle
// ends; a templated or unknown child id matches no Flow. Only system
// tables are read, never a collection. Binding: the coordinate type.
export const graphSql = `WITH RECURSIVE "managed"("flow") AS (
  SELECT "flow"::text FROM "directus_operations" WHERE "type" = ?
  UNION
  SELECT o."options"->>'flow' FROM "directus_operations" o JOIN "managed" m ON o."flow"::text = m."flow"
  WHERE o."type" = 'trigger' AND o."options"->>'flow' IS NOT NULL
)
SELECT f."id" AS "flow", f."trigger", f."options" AS "flow_options", f."operation" AS "entry",
  o."id" AS "operation", o."key", o."type", o."options", o."resolve", o."reject"
FROM "directus_flows" f LEFT JOIN "directus_operations" o ON o."flow" = f."id"
WHERE f."id"::text IN (SELECT "flow" FROM "managed")
ORDER BY f."id", o."id"`;

// Bindings: token, owner, domain, fingerprint, dirty JSON, domain, revision.
export const claimSql = `UPDATE "data_operations" SET "claim_token" = ?, "claim_owner" = ?, "claim_domain" = ?,
  "claim_revision" = "source_revision", "claim_fingerprint" = ?, "claim_started_at" = clock_timestamp(),
  "claim_heartbeat_at" = clock_timestamp(), "claim_pages" = NULL, "claim_staged" = '[]'::json,
  "dirty_domains" = ?::json,
  "publication_state" = CASE WHEN ? = 'publication' THEN 'running' ELSE "publication_state" END
WHERE "claim_token" IS NULL AND "source_revision" = ?`;

// A failure column set by a release, except for a snapshot promotion's
// claim: the promotion records its own failure in import_state and
// import_error, and must never replace the failure of a work domain, whose
// explicit retry decideClaim demands at the same revision.
const failureColumn = (column: string, value: string): string =>
  `"${column}" = CASE WHEN "claim_domain" = 'snapshot' THEN "${column}" ELSE ${value} END`;

// Bindings: error code, error message, publication state, token.
export const releaseSql = `UPDATE "data_operations" SET ${failureColumn('last_error_code', '?')},
  ${failureColumn('last_error_message', '?')},
  ${failureColumn('last_error_at', 'clock_timestamp()')}, ${failureColumn('last_failed_revision', '"claim_revision"')},
  ${failureColumn('last_failed_domain', '"claim_domain"')}, ${failureColumn('last_failed_fingerprint', '"claim_fingerprint"')},
  "publication_state" = CASE WHEN "claim_domain" = 'publication' THEN ? ELSE "publication_state" END, ${claimClear}
WHERE "claim_token" = ?`;

// A live claim's guard: no statement that touched the claimed domain's
// inputs committed since the claim was taken (verifyClaim).
const inputsUnchanged = `${claimInputRevision} <= "claim_revision"`;

// Bindings: dirty JSON, one outcome per published file, token, owner,
// claim revision, fingerprint.
export const finishSql = `UPDATE "data_operations" SET "dirty_domains" = ?::json, "completed_revision" = "claim_revision",
  "calculation_fingerprint" = CASE WHEN "claim_domain" IN ('history_index', 'enrollments') THEN "claim_fingerprint" ELSE "calculation_fingerprint" END,
  "publication_fingerprint" = CASE WHEN "claim_domain" = 'publication' THEN "claim_fingerprint" ELSE "publication_fingerprint" END,
  "publication_state" = CASE WHEN "claim_domain" = 'publication' THEN 'completed' ELSE "publication_state" END,
  ${publishedFiles
    .map(
      (file) =>
        `"publish_${file}_outcome" = CASE WHEN "claim_domain" = 'publication' THEN ? ELSE "publish_${file}_outcome" END`,
    )
    .join(', ')},
  "started_at" = "claim_started_at", "finished_at" = clock_timestamp(), ${claimClear}
WHERE "claim_token" = ? AND "claim_owner" = ? AND "claim_revision" = ? AND ${inputsUnchanged} AND "claim_fingerprint" = ?`;

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

// Bindings: token, page, revision, rows JSON.
export const insertSql = `INSERT INTO "data_operation_results" ("claim_token", "page_token", "course", "academic_year", "count", "revision")
SELECT ?, ?, rows."course", rows."academic_year", rows."count", ?
FROM json_to_recordset(?::json) AS rows("course" integer, "academic_year" integer, "count" integer)`;

// Bindings: revision, token.
export const installSql = `INSERT INTO "course_enrollments" ("course", "academic_year", "count", "computed_revision", "computed_at")
SELECT "course", "academic_year", SUM("count")::integer, ?, clock_timestamp()
FROM "data_operation_results" WHERE "claim_token" = ?
GROUP BY "course", "academic_year" ORDER BY "course", "academic_year"`;

// What an enrollments plan is cut from: the mode and pattern bytes of
// every rule (never its pattern) and the UTF-8 bytes of every raw history
// (never its text).
export const ruleModesSql = `SELECT "id", "mode", COALESCE(octet_length("pattern"), 0) AS "bytes" FROM "course_enrollment_rules" ORDER BY "id"`;

export const historySizesSql = `SELECT "id", COALESCE(octet_length("Courses"), 0) AS "bytes" FROM "moodle_users" ORDER BY "id"`;
