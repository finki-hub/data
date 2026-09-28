import { z } from 'zod';

import type {
  ExportedRow,
  SnapshotPort,
  SnapshotState,
  SnapshotStore,
} from './port.js';

import { importStates } from '../coordination/domains.js';
import { openWriterSql } from '../coordination/history-sql.js';
import {
  type SqlBinding,
  type SqlClient,
  type SqlDatabase,
  sqlPort,
} from '../coordination/sql-port.js';
import { snapshotFields, type SnapshotRow } from './contract.js';
import { summarySql } from './fingerprint.js';
import {
  activeDeletionSql,
  beginImportSql,
  beginPromotionSql,
  clearStagingSql,
  clockSql,
  completePromotionSql,
  consistentReadSql,
  exportBatchSql,
  failRunSql,
  finishImportSql,
  insertActiveSql,
  insertStagingSql,
  lockActiveSql,
  membershipDeletionSql,
  openStagingWriterSql,
  recordBackupSql,
  statementTimeoutSql,
  stateSql,
} from './sql.js';

const resultSchema = z.object({
  rowCount: z.number().nullable().optional(),
  rows: z.array(z.unknown()),
});

const text = z.string().nullable();
const integer = z.number().int().nullable();

const stateRow = z.object({
  finished_iso: text,
  import_backup_file: text,
  import_backup_fingerprint: text,
  import_backup_rows: integer,
  import_error: text,
  import_file: text,
  import_fingerprint: text,
  import_promoted_fingerprint: text,
  import_promoted_rows: integer,
  import_rows: integer,
  import_state: z.enum(importStates).catch('idle'),
  import_token: text,
  import_warnings: text,
  promoted_iso: text,
  started_age_ms: z.number().nullable(),
  started_iso: text,
});

const summaryRow = z.object({
  fingerprint: z.string(),
  rows: z.coerce.number().int().nonnegative(),
});

const exportRow = z.record(
  z.string(),
  z.union([z.null(), z.number(), z.string()]),
);
const run = async (
  client: SqlClient,
  sql: string,
  bindings: SqlBinding[] = [],
) => resultSchema.parse(await client.raw(sql, bindings));

const affected = async (
  client: SqlClient,
  sql: string,
  bindings: SqlBinding[] = [],
): Promise<number> => {
  const { rowCount } = await run(client, sql, bindings);
  return rowCount ?? 0;
};

const firstRow = async (client: SqlClient, sql: string): Promise<unknown> => {
  const { rows } = await run(client, sql);
  const [row] = rows;
  if (row === undefined) {
    throw new Error(
      'The data_operations status row is missing; run npm run setup.',
    );
  }
  return row;
};

const toState = (row: z.infer<typeof stateRow>): SnapshotState => ({
  backupFile: row.import_backup_file,
  backupFingerprint: row.import_backup_fingerprint,
  backupRows: row.import_backup_rows,
  error: row.import_error,
  file: row.import_file,
  fingerprint: row.import_fingerprint,
  finishedAt: row.finished_iso,
  promoted:
    row.import_promoted_fingerprint === null ||
    row.import_promoted_rows === null
      ? null
      : {
          at: row.promoted_iso,
          fingerprint: row.import_promoted_fingerprint,
          rows: row.import_promoted_rows,
        },
  rows: row.import_rows,
  startedAgeMs: row.started_age_ms,
  startedAt: row.started_iso,
  state: row.import_state,
  token: row.import_token,
  warnings: row.import_warnings,
});

const exported = (value: unknown): ExportedRow => {
  const row = exportRow.parse(value);
  const values: SnapshotRow = snapshotFields.map((field) => {
    const cell = row[field];
    if (cell === undefined) {
      throw new Error(`The active snapshot has no ${field} column.`);
    }
    return cell;
  });
  return { id: z.number().int().parse(row['id']), row: values };
};

const rowObjects = (rows: readonly SnapshotRow[]) =>
  rows.map((row) =>
    Object.fromEntries(
      snapshotFields.map((field, index) => [field, row[index] ?? null]),
    ),
  );

const snapshotSqlPort = (client: SqlClient): SnapshotPort => ({
  beginImport: async ({ file, token }) => {
    await run(client, beginImportSql, [token, file]);
  },
  beginPromotion: async (token) => {
    await run(client, beginPromotionSql, [token]);
  },
  boundStatements: async (milliseconds) => {
    await run(client, statementTimeoutSql, [String(milliseconds)]);
  },
  clearStaging: async () => {
    await run(client, clearStagingSql);
  },
  clock: async () =>
    z.object({ stamp: z.string() }).parse(await firstRow(client, clockSql))
      .stamp,
  completePromotion: async ({ claimToken, owner, promoted, token }) =>
    (await affected(client, completePromotionSql, [
      promoted.rows,
      promoted.fingerprint,
      claimToken,
      owner,
      token,
    ])) > 0,
  consistentRead: async () => {
    await run(client, consistentReadSql);
  },
  exportBatch: async (afterId, limit) => {
    const { rows } = await run(client, exportBatchSql, [afterId, limit]);
    return rows.map((row) => exported(row));
  },
  failRun: async ({ error, token }) =>
    (await affected(client, failRunSql, [error, token])) > 0,
  finishImport: async ({ fingerprint, rows, token, warnings }) =>
    (await affected(client, finishImportSql, [
      rows,
      fingerprint,
      warnings,
      token,
    ])) > 0,
  insertStaging: (rows) =>
    affected(client, insertStagingSql, [JSON.stringify(rowObjects(rows))]),
  lockActive: async () => {
    await run(client, lockActiveSql);
  },
  openStagingWriter: async () => {
    await run(client, openStagingWriterSql);
  },
  read: async () => toState(stateRow.parse(await firstRow(client, stateSql))),
  recordBackup: async ({ backup, token }) =>
    (await affected(client, recordBackupSql, [
      backup.file,
      backup.rows,
      backup.fingerprint,
      token,
    ])) > 0,
  replaceActive: async () => {
    await run(client, openWriterSql);
    const memberships = await affected(client, membershipDeletionSql);
    const removed = await affected(client, activeDeletionSql);
    const inserted = await affected(client, insertActiveSql);
    return { inserted, memberships, removed };
  },
  summary: async (table) =>
    summaryRow.parse(await firstRow(client, summarySql(table))),
});

// One transaction with both ports on the same connection.
export const snapshotStore = (database: SqlDatabase): SnapshotStore => ({
  transaction: (work) =>
    database.transaction((trx) =>
      work({ coordination: sqlPort(trx), snapshot: snapshotSqlPort(trx) }),
    ),
});
