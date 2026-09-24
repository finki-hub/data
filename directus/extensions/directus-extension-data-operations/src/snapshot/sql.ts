import { claimClear } from '../coordination/sql-state.js';
import { openGuardSql } from '../coordination/write-guards.js';
import {
  activeTable,
  integerFields,
  snapshotFields,
  stagingTable,
} from './contract.js';
import { quotedFields } from './fingerprint.js';

// Every statement binds its values with `?`; table and column names are
// the fixed snapshot contract, never caller input.

const isoText = (column: string, alias: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "${alias}"`;

export const stateSql = `SELECT "import_state", "import_token", "import_file", "import_rows",
  "import_fingerprint", "import_warnings", "import_error", "import_backup_file",
  "import_backup_rows", "import_backup_fingerprint", "import_promoted_rows",
  "import_promoted_fingerprint", ${isoText('"import_promoted_at"', 'promoted_iso')},
  ${isoText('"import_started_at"', 'started_iso')}, ${isoText('"import_finished_at"', 'finished_iso')},
  (EXTRACT(EPOCH FROM (clock_timestamp() - "import_started_at")) * 1000)::double precision AS "started_age_ms"
FROM "data_operations" ORDER BY "id" LIMIT 1`;

// Bindings: token, file.
export const beginImportSql = `UPDATE "data_operations" SET "import_state" = 'importing', "import_token" = ?,
  "import_file" = ?, "import_rows" = NULL, "import_fingerprint" = NULL, "import_warnings" = NULL,
  "import_error" = NULL, "import_started_at" = clock_timestamp(), "import_finished_at" = NULL`;

// Bindings: token. Runs on its own connection while the staging
// transaction is still open, so the status shows the validation phase.
export const markValidatingSql = `UPDATE "data_operations" SET "import_state" = 'validating'
WHERE "import_token" = ? AND "import_state" = 'importing'`;

// Bindings: rows, fingerprint, warnings, token.
export const finishImportSql = `UPDATE "data_operations" SET "import_state" = 'ready', "import_rows" = ?,
  "import_fingerprint" = ?, "import_warnings" = ?, "import_finished_at" = clock_timestamp()
WHERE "import_token" = ? AND "import_state" = 'validating'`;

// Bindings: error text, token.
export const failRunSql = `UPDATE "data_operations" SET "import_state" = 'failed', "import_error" = ?,
  "import_finished_at" = clock_timestamp()
WHERE "import_token" = ? AND "import_state" IN ('importing', 'validating', 'promoting')`;

// Bindings: token.
export const beginPromotionSql = `UPDATE "data_operations" SET "import_state" = 'promoting', "import_token" = ?,
  "import_error" = NULL, "import_finished_at" = NULL`;

// Bindings: backup file, rows, fingerprint, token.
export const recordBackupSql = `UPDATE "data_operations" SET "import_backup_file" = ?, "import_backup_rows" = ?,
  "import_backup_fingerprint" = ?
WHERE "import_token" = ? AND "import_state" = 'promoting'`;

// Bindings: promoted rows, promoted fingerprint, claim token, owner,
// token. Records the identity of the snapshot that is now active (never
// touched by a later import, so readiness can always compare the active
// rows with it) and clears the snapshot claim in the same statement: the
// replacement, its pending revision (set by the moodle_users trigger
// inside this transaction) and the release commit together.
export const completePromotionSql = `UPDATE "data_operations" SET "import_state" = 'completed',
  "import_finished_at" = clock_timestamp(), "import_error" = NULL, "import_promoted_rows" = ?,
  "import_promoted_fingerprint" = ?, "import_promoted_at" = clock_timestamp(), ${claimClear}
WHERE "claim_token" = ? AND "claim_owner" = ? AND "claim_domain" = 'snapshot'
  AND "import_token" = ? AND "import_state" = 'promoting'`;

// Transaction-local: admits this transaction past the staging write guard
// of the schema-constraints migration, and ends with it.
export const openStagingWriterSql = openGuardSql(stagingTable);

// Bindings: milliseconds.
export const statementTimeoutSql = `SELECT set_config('statement_timeout', ?, true)`;

// A plain DELETE, not TRUNCATE: it takes ROW EXCLUSIVE only and is
// MVCC-safe, so the status report and Studio keep reading the committed
// staging while an import or a promotion runs instead of waiting for its
// commit. Staging ids keep counting across imports; only their order
// inside one import matters.
export const clearStagingSql = `DELETE FROM "${stagingTable}"`;

const recordColumns = snapshotFields
  .map(
    (field) =>
      `"${field}" ${integerFields.includes(field) ? 'integer' : 'text'}`,
  )
  .join(', ');

// Bindings: rows JSON (objects keyed by the snapshot fields). JSON strings
// arrive in PostgreSQL unchanged, JSON null as NULL.
export const insertStagingSql = `INSERT INTO "${stagingTable}" (${quotedFields})
SELECT ${quotedFields} FROM json_to_recordset(?::json) AS rows(${recordColumns})`;

// Readers keep reading the previous rows until the promotion commits;
// writers of moodle_users wait here before the singleton is locked, so
// the lock order is always table, then singleton.
export const lockActiveSql = `LOCK TABLE "${activeTable}" IN EXCLUSIVE MODE`;

export const membershipDeletionSql = 'DELETE FROM "moodle_history_memberships"';

export const activeDeletionSql = `DELETE FROM "${activeTable}"`;

// New Directus ids follow the staging order; they are never identity keys.
export const insertActiveSql = `INSERT INTO "${activeTable}" (${quotedFields})
SELECT ${quotedFields} FROM "${stagingTable}" ORDER BY "id"`;

export const consistentReadSql =
  'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY';

export const clockSql = `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"') AS "stamp"`;

// Bindings: last id, limit.
export const exportBatchSql = `SELECT "id", ${quotedFields} FROM "${activeTable}"
WHERE "id" > ? ORDER BY "id" LIMIT ?`;

// Bindings: file id.
export const fileSql = `SELECT "id", "storage", "type", "filename_download", "filesize", "folder"
FROM "directus_files" WHERE "id" = ?`;
