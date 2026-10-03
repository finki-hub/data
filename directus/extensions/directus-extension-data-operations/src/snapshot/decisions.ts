import type { z } from 'zod';

import type { OperationsState } from '../coordination/state.js';
import type { FileFacts, SnapshotState } from './port.js';

import { callerRefusal } from '../access.js';
import { invalidOptionsText } from '../text.js';
import {
  csvTypes,
  type PromoteOptions,
  snapshotFolderId,
  snapshotFolderName,
} from './contract.js';
import { claimBusy, type SnapshotError, snapshotError } from './errors.js';

// Both operations write with system rights, so they refuse a caller the
// caller check refuses (access.ts) before anything is read or written.
export const requireCaller = (accountability: unknown): void => {
  const refusal = callerRefusal(accountability);
  if (refusal !== null) {
    throw snapshotError(refusal.reason, refusal.message);
  }
};

export const parseOptions = <T>(schema: z.ZodType<T>, options: unknown): T => {
  const parsed = schema.safeParse(options);
  if (parsed.success) {
    return parsed.data;
  }
  const fields = [
    ...new Set(parsed.error.issues.map(({ path }) => path.join('.'))),
  ];
  throw snapshotError(
    'INVALID_OPTIONS',
    invalidOptionsText(parsed.error.issues),
    { fields },
  );
};

// Whether a new import may start. An import still running within its
// deadline, or a promotion that holds its claim, keeps the staging table;
// anything else (idle, ready, completed, failed, or an in-flight state
// whose run died) is replaced by the new import.
export const importRefusal = (
  snapshot: SnapshotState,
  claim: OperationsState['claim'],
  staleAfterMs: number,
): null | SnapshotError => {
  if (
    (snapshot.state === 'importing' || snapshot.state === 'validating') &&
    (snapshot.startedAgeMs ?? Infinity) <= staleAfterMs
  ) {
    return snapshotError(
      'IMPORT_RUNNING',
      `Snapshot import running: state ${snapshot.state}, stale after ${String(Math.round(staleAfterMs / 1_000))} s`,
    );
  }
  if (snapshot.state === 'promoting' && claim?.domain === 'snapshot') {
    return snapshotError('PROMOTION_RUNNING', 'Snapshot promotion running');
  }
  return null;
};

// Whether the staged snapshot may replace the active one: no other data
// operation holds the claim, the staging is ready (or its previous
// promotion died before committing), it is the snapshot the caller was
// shown, and an empty snapshot is confirmed separately.
export const promotionRefusal = (
  operations: OperationsState,
  snapshot: SnapshotState,
  options: PromoteOptions,
): null | SnapshotError => {
  if (operations.claim !== null) {
    return claimBusy(operations.claim.domain);
  }
  if (snapshot.state !== 'ready' && snapshot.state !== 'promoting') {
    return snapshotError(
      'NOT_READY',
      `No staged snapshot: import state ${snapshot.state}`,
    );
  }
  if (snapshot.fingerprint !== options.staging_fingerprint) {
    return snapshotError(
      'FINGERPRINT_MISMATCH',
      'Staged snapshot fingerprint mismatch',
    );
  }
  if ((snapshot.rows ?? 0) === 0 && !options.allow_empty) {
    return snapshotError(
      'EMPTY_NOT_CONFIRMED',
      'Staged snapshot empty: allow_empty not confirmed',
    );
  }
  return null;
};

// The one wording of a file over the byte bound; the streaming check
// (stage.ts) knows only that the bytes read went above it.
export const fileTooLarge = (maxBytes: number, size?: number): SnapshotError =>
  snapshotError(
    'FILE_INVALID',
    size === undefined
      ? `File size above max ${String(maxBytes)} bytes (FINKI_HUB_SNAPSHOT_MAX_BYTES)`
      : `File size ${String(size)} bytes, max ${String(maxBytes)} (FINKI_HUB_SNAPSHOT_MAX_BYTES)`,
  );

const csvName = /\.csv$/iu;

// The file must be a private CSV of the local storage location, in the
// snapshot folder, within the byte bound. A browser may report a .csv
// upload as text/csv, as Excel's type or as plain text; the name must then
// end in .csv.
export const fileRefusal = (
  file: FileFacts | null,
  maxBytes: number,
): null | SnapshotError => {
  if (file === null) {
    return snapshotError('FILE_INVALID', 'File not found');
  }
  if (file.storage !== 'local') {
    return snapshotError(
      'FILE_INVALID',
      `File storage "${file.storage}", expected "local"`,
    );
  }
  if (file.folder !== snapshotFolderId) {
    return snapshotError(
      'FILE_INVALID',
      `File outside folder "${snapshotFolderName}"`,
    );
  }
  const named = csvName.test(file.filename ?? '');
  if (!(
    file.type === 'text/csv' ||
    (named && csvTypes.includes(file.type ?? ''))
  )) {
    return snapshotError(
      'FILE_INVALID',
      `File type ${file.type ?? 'none'}, expected text/csv or a .csv name`,
    );
  }
  if (file.size !== null && file.size > maxBytes) {
    return fileTooLarge(maxBytes, file.size);
  }
  return null;
};
