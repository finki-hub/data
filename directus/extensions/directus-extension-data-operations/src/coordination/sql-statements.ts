import { claimClear, columns, dirtyUnion } from './sql-state.js';
import { publishedFiles } from './state.js';

// Every statement below binds its values with `?`; none of them carries a
// caller-supplied identifier. SET expressions read the row as it was
// before the update, which is what lets a release copy the claim columns
// into the failure columns while clearing them in the same statement.

export const stateSql = (lock: boolean): string =>
  `SELECT ${columns} FROM "data_operations" ORDER BY "id" LIMIT 1${lock ? ' FOR UPDATE' : ''}`;

export const graphSql = `SELECT f."id" AS "flow", f."trigger", f."options" AS "flow_options", f."operation" AS "entry",
  o."id" AS "operation", o."key", o."type", o."options", o."resolve", o."reject"
FROM "directus_flows" f LEFT JOIN "directus_operations" o ON o."flow" = f."id"
WHERE f."id" IN (SELECT "flow" FROM "directus_operations" WHERE "type" = ?)
ORDER BY f."id", o."id"`;

// Bindings: token, owner, domain, fingerprint, dirty JSON, domain, revision.
export const claimSql = `UPDATE "data_operations" SET "claim_token" = ?, "claim_owner" = ?, "claim_domain" = ?,
  "claim_revision" = "source_revision", "claim_fingerprint" = ?, "claim_started_at" = clock_timestamp(),
  "claim_heartbeat_at" = clock_timestamp(), "claim_pages" = NULL, "claim_staged" = '[]'::json,
  "dirty_domains" = ?::json,
  "publication_state" = CASE WHEN ? = 'publication' THEN 'running' ELSE "publication_state" END
WHERE "claim_token" IS NULL AND "source_revision" = ?`;

// Bindings: error code, publication state, token.
export const releaseSql = `UPDATE "data_operations" SET "last_error_code" = ?, "last_error_at" = clock_timestamp(),
  "last_failed_revision" = "claim_revision", "last_failed_domain" = "claim_domain", "last_failed_fingerprint" = "claim_fingerprint",
  "publication_state" = CASE WHEN "claim_domain" = 'publication' THEN ? ELSE "publication_state" END, ${claimClear}
WHERE "claim_token" = ?`;

// Bindings: dirty JSON, one outcome per published file, token, owner,
// revision, fingerprint.
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
WHERE "claim_token" = ? AND "claim_owner" = ? AND "source_revision" = ? AND "claim_fingerprint" = ?`;

// Bindings: page, token, owner. The append happens in SQL under the row
// lock, so parallel pages never lose each other's entries.
export const stagedSql = `UPDATE "data_operations" SET "claim_heartbeat_at" = clock_timestamp(), "claim_staged" = (
  SELECT COALESCE(json_agg(page ORDER BY page), '[]'::json) FROM (
    SELECT DISTINCT page FROM (
      SELECT json_array_elements_text(CASE WHEN json_typeof("claim_staged") = 'array' THEN "claim_staged" ELSE '[]'::json END) AS page
      UNION ALL SELECT ?::text
    ) AS pages
  ) AS staged
) WHERE "claim_token" = ? AND "claim_owner" = ? AND "source_revision" = "claim_revision"`;

// Bindings: planned pages JSON ({ token, from, to, rows } each), token,
// owner.
export const planSql = `UPDATE "data_operations" SET "claim_pages" = ?::json, "claim_staged" = '[]'::json, "claim_heartbeat_at" = clock_timestamp()
WHERE "claim_token" = ? AND "claim_owner" = ? AND "source_revision" = "claim_revision"`;

// Bindings: marked domains JSON.
export const markSql = `UPDATE "data_operations" SET "source_revision" = "source_revision" + 1, "requested_revision" = "source_revision" + 1,
  "dirty_domains" = ${dirtyUnion('?::json')} RETURNING "source_revision", "dirty_domains"`;

// Bindings: token, page, revision, rows JSON.
export const insertSql = `INSERT INTO "data_operation_results" ("claim_token", "page_token", "course", "academic_year", "count", "revision")
SELECT ?, ?, rows."course", rows."academic_year", rows."count", ?
FROM json_to_recordset(?::json) AS rows("course" integer, "academic_year" integer, "count" integer)`;

// Bindings: revision, token.
export const installSql = `INSERT INTO "course_enrollments" ("course", "academic_year", "count", "computed_revision", "computed_at")
SELECT "course", "academic_year", SUM("count")::integer, ?, clock_timestamp()
FROM "data_operation_results" WHERE "claim_token" = ?
GROUP BY "course", "academic_year" ORDER BY "course", "academic_year"`;
