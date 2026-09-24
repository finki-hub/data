import { calculationDomains } from './domains.js';
import {
  calculationRunnerRoots,
  calculationTargets,
  neutralActions,
  pageStepActions,
  publicationTargets,
} from './fingerprint.js';
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
const claimed = `o."options"->>'domain'`;

// One row of a VALUES list holding a fixed identifier.
const valuesRow = (value: string): string => `(${literals([value])})`;

// The declared runner Flows (fixed identifiers of the rule-mode registry)
// as more roots of the calculation graph; none when no mode is declared.
const runnerRoots = (runners: readonly string[]): string =>
  runners.length === 0
    ? ''
    : `
  UNION SELECT 'calculation', runners."flow" FROM (VALUES ${runners.map(valuesRow).join(', ')}) AS runners("flow")`;

// The managed Flow graphs, partitioned by what their coordinate steps do
// (graphKindsOf in fingerprint.ts is the same rule): a Flow is a root of
// the calculation graph when it claims a calculation domain or
// next_calculation or plans, stages or indexes pages, and a root of the
// publication graph when it claims publication; a templated or unknown
// action or claim domain roots both, and a Flow holding only mark, status,
// heartbeat, complete or fail steps roots neither. The runner of every
// declared rule mode roots the calculation graph as well (its caller's
// flow id is templated). Each graph adds every Flow its roots reach
// through Trigger Flow operations; UNION stops at Flows already reached,
// so a cycle ends, and a templated or unknown child id matches no Flow.
// Only system tables are read, never a collection. Binding: the coordinate
// type.
export const graphSqlOf = (
  runners: readonly string[],
): string => `WITH RECURSIVE "roots"("graph", "flow") AS (
  SELECT DISTINCT kinds."graph", o."flow"::text FROM "directus_operations" o
  CROSS JOIN (VALUES ('calculation'), ('publication')) AS kinds("graph")
  WHERE o."type" = ? AND CASE
    WHEN ${action} IN (${literals(neutralActions)}) THEN false
    WHEN ${action} IN (${literals(pageStepActions)}) THEN kinds."graph" = 'calculation'
    WHEN ${action} = 'claim' AND ${claimed} IN (${literals(calculationTargets)}) THEN kinds."graph" = 'calculation'
    WHEN ${action} = 'claim' AND ${claimed} IN (${literals(publicationTargets)}) THEN kinds."graph" = 'publication'
    ELSE true END${runnerRoots(runners)}
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

export const graphSql = graphSqlOf(calculationRunnerRoots);

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

// Bindings: error code, error message, publication state, the per-file
// outcomes JSON (or null, which keeps the recorded outcomes), token.
export const releaseSql = `UPDATE "data_operations" SET ${failureColumn('last_error_code', '?')},
  ${failureColumn('last_error_message', '?')},
  ${failureColumn('last_error_at', 'clock_timestamp()')}, ${failureColumn('last_failed_revision', '"claim_revision"')},
  ${failureColumn('last_failed_domain', '"claim_domain"')}, ${failureColumn('last_failed_fingerprint', '"claim_fingerprint"')},
  "publication_state" = CASE WHEN "claim_domain" = 'publication' THEN ? ELSE "publication_state" END,
  "publication_outcomes" = CASE WHEN "claim_domain" = 'publication' THEN COALESCE(?::json, "publication_outcomes") ELSE "publication_outcomes" END, ${claimClear}
WHERE "claim_token" = ?`;

// A live claim's guard: no statement that touched the claimed domain's
// inputs committed since the claim was taken (verifyClaim).
const inputsUnchanged = `${claimInputRevision} <= "claim_revision"`;

// Bindings: dirty JSON, the per-file outcomes JSON (or null), token,
// owner, claim revision, whether a superseded publication may finish after
// a source change (decideCompletion), fingerprint.
export const finishSql = `UPDATE "data_operations" SET "dirty_domains" = ?::json, "completed_revision" = "claim_revision",
  "calculation_fingerprint" = CASE WHEN "claim_domain" IN (${literals(calculationDomains)}) THEN "claim_fingerprint" ELSE "calculation_fingerprint" END,
  "publication_fingerprint" = CASE WHEN "claim_domain" = 'publication' THEN "claim_fingerprint" ELSE "publication_fingerprint" END,
  "publication_state" = CASE WHEN "claim_domain" = 'publication' THEN 'completed' ELSE "publication_state" END,
  "publication_outcomes" = CASE WHEN "claim_domain" = 'publication' THEN ?::json ELSE "publication_outcomes" END,
  "started_at" = "claim_started_at", "finished_at" = clock_timestamp(), ${claimClear}
WHERE "claim_token" = ? AND "claim_owner" = ? AND "claim_revision" = ?
  AND (${inputsUnchanged} OR (?::boolean AND "claim_domain" = 'publication')) AND "claim_fingerprint" = ?`;

// Bindings: lease in milliseconds, token, owner.
export const heartbeatSql = `UPDATE "data_operations" SET "claim_heartbeat_at" = clock_timestamp() + ?::integer * interval '1 millisecond'
WHERE "claim_token" = ? AND "claim_owner" = ?`;

// Bindings: the outcome map JSON, token, owner.
export const recordSql = `UPDATE "data_operations" SET "publication_outcomes" = ?::json, "claim_heartbeat_at" = clock_timestamp()
WHERE "claim_token" = ? AND "claim_owner" = ? AND "claim_domain" = 'publication'`;

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
