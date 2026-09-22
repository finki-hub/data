import { performance } from 'node:perf_hooks';

import type { CsvCell } from './csv-types.js';
import type { BackupRecord, SnapshotPort } from './port.js';
import type { SnapshotDeps } from './stage.js';

import {
  activeTable,
  backupBatchRows,
  integerFields,
  maxFieldChars,
  snapshotFields,
  type SnapshotRow,
  type SnapshotValue,
} from './contract.js';
import { readCsv } from './csv-parser.js';
import { type SnapshotError, snapshotError } from './errors.js';
import { SnapshotFingerprint } from './fingerprint.js';

// The private pre-replacement backup: the active Moodle users as a CSV of
// exactly the 38 snapshot fields in id order, written with the reader's
// lossless convention (NULL as an empty unquoted cell, every text quoted,
// so an empty text stays empty text). It is therefore a valid snapshot:
// restoring it is an explicit run of the same import and promotion, and
// re-staging it reproduces the fingerprint of the rows it saved. It lives
// in the local storage location as a new file and is never deleted by the
// workflow.

const csvCell = (value: SnapshotValue): string => {
  if (value === null) {
    return '';
  }
  return typeof value === 'number'
    ? String(value)
    : `"${value.replaceAll('"', '""')}"`;
};

export const csvLine = (values: readonly SnapshotValue[]): string =>
  `${values.map((value) => csvCell(value)).join(',')}\r\n`;

// Keeps the promotion's snapshot claim alive while the backup of a large
// snapshot is exported, uploaded and read back: beat() refreshes the
// heartbeat once limits.heartbeatMs have passed since the last refresh,
// and the run stops as soon as the claim is gone (a recovery released it),
// instead of finishing a backup whose replacement can no longer happen.
export class ClaimKeeper {
  public lost: null | SnapshotError = null;
  readonly #deps: SnapshotDeps;
  #last = performance.now();
  readonly #token: string;

  public constructor(deps: SnapshotDeps, token: string) {
    this.#deps = deps;
    this.#token = token;
  }

  public async beat(): Promise<void> {
    if (performance.now() - this.#last < this.#deps.limits.heartbeatMs) {
      return;
    }
    this.#last = performance.now();
    if (!(await this.#deps.heartbeat(this.#token))) {
      this.lost = snapshotError(
        'CLAIM_LOST',
        'The snapshot claim was released while the backup was written; nothing was replaced.',
      );
      throw this.lost;
    }
  }
}

const backupLines = async function* (
  snapshot: SnapshotPort,
  written: { rows: number },
  keeper: ClaimKeeper,
): AsyncGenerator<string> {
  yield csvLine(snapshotFields);
  let last = 0;
  for (;;) {
    const batch = await snapshot.exportBatch(last, backupBatchRows);
    if (batch.length === 0) {
      return;
    }
    written.rows += batch.length;
    last = batch.at(-1)?.id ?? last;
    yield batch.map(({ row }) => csvLine(row)).join('');
    await keeper.beat();
  }
};

const storedValue = (index: number, cell: CsvCell): SnapshotValue => {
  const field = snapshotFields[index];
  if (cell === null || field === undefined) {
    return null;
  }
  return integerFields.includes(field) ? Number(cell) : cell;
};

// Reads the stored file back and fingerprints it: the backup counts only
// when it holds exactly the rows it was written from.
const verifyBackup = async (
  deps: SnapshotDeps,
  file: string,
  keeper: ClaimKeeper,
): Promise<{ fingerprint: string; rows: number }> => {
  const fingerprint = new SnapshotFingerprint();
  let header = true;
  const records = readCsv(await deps.files.open(file), {
    maxCellChars: maxFieldChars,
    maxCells: snapshotFields.length,
  });
  for await (const record of records) {
    await keeper.beat();
    if (header) {
      header = false;
      if (record.cells.join('\n') !== snapshotFields.join('\n')) {
        throw snapshotError(
          'BACKUP_FAILED',
          'The stored backup has an unexpected header row.',
        );
      }
      continue;
    }
    if (record.cells.length !== snapshotFields.length) {
      throw snapshotError(
        'BACKUP_FAILED',
        `The stored backup has a malformed row on line ${record.line}.`,
      );
    }
    const row: SnapshotRow = snapshotFields.map((_, index) =>
      storedValue(index, record.cells[index] ?? null),
    );
    fingerprint.add(row);
  }
  return { fingerprint: fingerprint.digest(), rows: fingerprint.rows };
};

// The upload reports a source stream that stopped on a lost claim as a
// storage error of its own; the keeper's refusal is what happened.
const uploadBackup = async (
  deps: SnapshotDeps,
  lines: AsyncIterable<string>,
  target: { readonly keeper: ClaimKeeper; readonly title: string },
): Promise<string> => {
  try {
    return await deps.files.upload(lines, target.title);
  } catch (error) {
    throw target.keeper.lost ?? error;
  }
};

// Writes the backup from one consistent read of the active rows, then
// verifies the stored file against the database's own count and
// fingerprint of the rows it was written from; the keeper beats between
// export batches and verified records.
export const writeBackup = async (
  deps: SnapshotDeps,
  keeper: ClaimKeeper,
): Promise<BackupRecord> => {
  const written = await deps.store.transaction(async ({ snapshot }) => {
    await snapshot.consistentRead();
    const stamp = await snapshot.clock();
    const summary = await snapshot.summary(activeTable);
    const counter = { rows: 0 };
    const file = await uploadBackup(
      deps,
      backupLines(snapshot, counter, keeper),
      { keeper, title: `moodle-users-backup-${stamp}.csv` },
    );
    if (counter.rows !== summary.rows) {
      throw snapshotError(
        'BACKUP_FAILED',
        `The backup wrote ${counter.rows} rows of ${summary.rows} active Moodle users.`,
      );
    }
    return { file, ...summary };
  });
  const stored = await verifyBackup(deps, written.file, keeper);
  if (
    stored.rows !== written.rows ||
    stored.fingerprint !== written.fingerprint
  ) {
    throw snapshotError(
      'BACKUP_FAILED',
      `The stored backup ${written.file} holds ${stored.rows} rows that do not match the ${written.rows} active Moodle users it was written from; nothing was replaced.`,
    );
  }
  return written;
};
