import { z } from 'zod';

import type { OperationsState } from '../coordination/state.js';
import type { FileFacts, SnapshotState } from './port.js';

import {
  csvTypes,
  type PromoteOptions,
  snapshotFolderId,
  snapshotFolderName,
} from './contract.js';
import { type SnapshotError, snapshotError } from './errors.js';

const adminAccountability = z.object({ admin: z.literal(true) });

// Both operations serve administrators only, whatever the Flow around them
// checks: an administrator can build a Flow of their own, nobody else can
// run one that reaches these operations with another identity.
export const requireAdmin = (accountability: unknown): void => {
  if (!adminAccountability.safeParse(accountability).success) {
    throw snapshotError(
      'FORBIDDEN',
      'Only administrators may import or promote a Moodle snapshot.',
    );
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
    `Invalid snapshot options (${fields.join(', ') || 'options'}).`,
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
      `A snapshot import is already ${snapshot.state}; wait until it ends (at most ${Math.round(staleAfterMs / 1_000)} s after it started).`,
    );
  }
  if (snapshot.state === 'promoting' && claim?.domain === 'snapshot') {
    return snapshotError(
      'PROMOTION_RUNNING',
      'A snapshot promotion is running; wait until it ends.',
    );
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
    return snapshotError(
      'CLAIM_BUSY',
      `Another data operation (${operations.claim.domain ?? 'unknown'}) holds the claim; promote once it has finished.`,
    );
  }
  if (snapshot.state !== 'ready' && snapshot.state !== 'promoting') {
    return snapshotError(
      'NOT_READY',
      `No staged snapshot is ready (the import state is ${snapshot.state}); import the CSV first.`,
    );
  }
  if (snapshot.fingerprint !== options.staging_fingerprint) {
    return snapshotError(
      'FINGERPRINT_MISMATCH',
      'The staged snapshot is not the one this promotion was asked for; import the file again and promote its fingerprint.',
    );
  }
  if ((snapshot.rows ?? 0) === 0 && !options.allow_empty) {
    return snapshotError(
      'EMPTY_NOT_CONFIRMED',
      'The staged snapshot has no rows; replacing the active Moodle users with nothing needs the separate "Allow an empty snapshot" confirmation.',
    );
  }
  return null;
};

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
    return snapshotError('FILE_INVALID', 'No file with this id exists.');
  }
  if (file.storage !== 'local') {
    return snapshotError(
      'FILE_INVALID',
      `The CSV must be a private upload in the local storage location, not in "${file.storage}".`,
    );
  }
  if (file.folder !== snapshotFolderId) {
    return snapshotError(
      'FILE_INVALID',
      `The CSV must be uploaded into the File Library folder "${snapshotFolderName}" (created by npm run setup), which holds the private snapshot files; move it there and run the import again.`,
    );
  }
  const named = csvName.test(file.filename ?? '');
  if (!(
    file.type === 'text/csv' ||
    (named && csvTypes.includes(file.type ?? ''))
  )) {
    return snapshotError(
      'FILE_INVALID',
      `The file must be a CSV (text/csv, or a .csv name); it is ${file.type ?? 'untyped'}.`,
    );
  }
  if (file.size !== null && file.size > maxBytes) {
    return snapshotError(
      'FILE_INVALID',
      `The file has ${file.size} bytes; a snapshot holds at most ${maxBytes} (FINKI_HUB_SNAPSHOT_MAX_BYTES).`,
    );
  }
  return null;
};
