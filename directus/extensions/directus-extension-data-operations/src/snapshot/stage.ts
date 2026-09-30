import type { ActionContext } from '../coordination/action-support.js';
import type { SnapshotFiles, SnapshotPort, SnapshotStore } from './port.js';

import { countText } from '../text.js';
import {
  batchChars,
  batchRows,
  maxFieldChars,
  maxRows,
  snapshotFields,
  type SnapshotRow,
  stagingTable,
} from './contract.js';
import { readCsv } from './csv-parser.js';
import { CsvFormatError } from './csv-types.js';
import { fileRefusal, fileTooLarge } from './decisions.js';
import { snapshotError, type SnapshotLog } from './errors.js';
import { SnapshotFingerprint } from './fingerprint.js';
import {
  describeWarnings,
  headerPositions,
  SnapshotRows,
  type SnapshotWarnings,
  warningsOf,
} from './rows.js';

// Everything the two operations need from Directus, narrowed so the unit
// suite can run them over fakes.
export type SnapshotDeps = {
  readonly accountability: unknown;
  readonly claims: ActionContext;
  readonly files: SnapshotFiles;
  // Refreshes the heartbeat of this process's claim with the token, in a
  // transaction of its own; false once the claim is gone.
  readonly heartbeat: (token: string) => Promise<boolean>;
  readonly limits: SnapshotLimits;
  readonly log: SnapshotLog;
  // Commits the validating state on a connection of its own while the
  // staging transaction is still open.
  readonly markValidating: (token: string) => Promise<void>;
  readonly owner: string;
  readonly store: SnapshotStore;
};

type SnapshotLimits = {
  // How often a long promotion step refreshes its claim's heartbeat.
  readonly heartbeatMs: number;
  readonly maxBytes: number;
  readonly timeoutMs: number;
};

type StagedSnapshot = {
  readonly fingerprint: string;
  readonly rows: number;
  readonly warnings: null | SnapshotWarnings;
};

const maxCells = snapshotFields.length + 26;

const charsOf = (row: SnapshotRow): number =>
  row.reduce<number>(
    (total, value) => total + (typeof value === 'string' ? value.length : 8),
    0,
  );

const checkDeadline = (deadline: AbortSignal, limits: SnapshotLimits) => {
  if (deadline.aborted) {
    throw snapshotError(
      'IMPORT_TIMEOUT',
      `Import timed out after ${String(limits.timeoutMs)} ms (IMPORT_TIMEOUT)`,
    );
  }
};

type Parsed = {
  readonly checks: SnapshotRows;
  readonly fingerprint: string;
  readonly staged: number;
};

// The byte bound and the deadline, checked on every chunk: a file that
// grows past the bound or a read that outlives IMPORT_TIMEOUT stops the
// run, and leaving the loop destroys the source stream. Every statement
// of the staging transaction is bounded by the same deadline.
const bounded = async function* (
  source: AsyncIterable<string | Uint8Array>,
  limits: SnapshotLimits,
  deadline: AbortSignal,
): AsyncGenerator<string | Uint8Array> {
  let bytes = 0;
  for await (const chunk of source) {
    checkDeadline(deadline, limits);
    bytes += typeof chunk === 'string' ? chunk.length : chunk.byteLength;
    if (bytes > limits.maxBytes) {
      throw fileTooLarge(limits.maxBytes);
    }
    yield chunk;
  }
};

// Streams the records into the staging table in batches bounded by rows
// and characters. Once a record is invalid nothing more is staged, but the
// rest of the file is still checked so the refusal can say how many rows
// are wrong.
const stageRecords = async (
  chunks: AsyncIterable<string | Uint8Array>,
  snapshot: SnapshotPort,
): Promise<Parsed> => {
  let checks: null | SnapshotRows = null;
  const fingerprint = new SnapshotFingerprint();
  let batch: SnapshotRow[] = [];
  let chars = 0;
  const records = readCsv(chunks, { maxCellChars: maxFieldChars, maxCells });
  for await (const record of records) {
    if (checks === null) {
      checks = new SnapshotRows(headerPositions(record.cells));
      continue;
    }
    if (checks.rows >= maxRows) {
      throw snapshotError('INVALID_ROWS', `Rows above max ${String(maxRows)}`);
    }
    const row = checks.accept(record);
    if (row === null || checks.problems > 0) {
      continue;
    }
    fingerprint.add(row);
    batch.push(row);
    chars += charsOf(row);
    if (batch.length === batchRows || chars >= batchChars) {
      await snapshot.insertStaging(batch);
      batch = [];
      chars = 0;
    }
  }
  if (checks === null) {
    throw snapshotError('INVALID_HEADERS', 'File empty: no header row');
  }
  if (checks.problems === 0 && batch.length > 0) {
    await snapshot.insertStaging(batch);
  }
  return {
    checks,
    fingerprint: fingerprint.digest(),
    staged: fingerprint.rows,
  };
};

// A structural CSV error as the import's refusal.
const readRecords = async (
  chunks: AsyncIterable<string | Uint8Array>,
  snapshot: SnapshotPort,
): Promise<Parsed> => {
  try {
    return await stageRecords(chunks, snapshot);
  } catch (error) {
    if (!(error instanceof CsvFormatError)) {
      throw error;
    }
    throw snapshotError('INVALID_CSV', `Invalid CSV: ${error.message}`, {
      line: error.line,
      problem: error.problem,
    });
  }
};

// Stages the private CSV inside ONE transaction: the previous staging rows
// are deleted, every row is checked and inserted, and the database's own
// count and fingerprint of the staged rows must equal what was read. The
// state turns ready in the same transaction, so ready is visible only
// together with the committed rows; any failure rolls all of it back.
export const stageFile = async (
  input: { readonly file: string; readonly token: string },
  deps: SnapshotDeps,
): Promise<StagedSnapshot> => {
  const refusal = fileRefusal(
    await deps.files.describe(input.file),
    deps.limits.maxBytes,
  );
  if (refusal !== null) {
    throw refusal;
  }
  const deadline = AbortSignal.timeout(deps.limits.timeoutMs);
  return deps.store.transaction(async ({ snapshot }) => {
    await snapshot.boundStatements(deps.limits.timeoutMs);
    await snapshot.openStagingWriter();
    await snapshot.clearStaging();
    const source = bounded(
      await deps.files.open(input.file),
      deps.limits,
      deadline,
    );
    const parsed = await readRecords(source, snapshot);
    checkDeadline(deadline, deps.limits);
    await deps.markValidating(input.token);
    if (parsed.checks.problems > 0) {
      throw snapshotError('INVALID_ROWS', parsed.checks.describe(), {
        problems: parsed.checks.problems,
      });
    }
    const stored = await snapshot.summary(stagingTable);
    if (
      stored.rows !== parsed.staged ||
      stored.fingerprint !== parsed.fingerprint
    ) {
      throw snapshotError(
        'COUNT_MISMATCH',
        `Staging mismatch: stored ${countText(stored.rows, 'row', 'rows')}, read ${countText(parsed.staged, 'row', 'rows')}`,
      );
    }
    const warnings = warningsOf(parsed.checks);
    const finished = await snapshot.finishImport({
      fingerprint: stored.fingerprint,
      rows: stored.rows,
      token: input.token,
      warnings: warnings === null ? null : describeWarnings(warnings),
    });
    if (!finished) {
      throw snapshotError(
        'IMPORT_RUNNING',
        'Import superseded by another import',
      );
    }
    return { fingerprint: stored.fingerprint, rows: stored.rows, warnings };
  });
};
