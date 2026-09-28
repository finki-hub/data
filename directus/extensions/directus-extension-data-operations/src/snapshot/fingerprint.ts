import { createHash } from 'node:crypto';

import type { SnapshotTable } from './port.js';

import { snapshotFields, type SnapshotRow } from './contract.js';

// The fingerprint of a snapshot: sha256 over the concatenated hex sha256
// digests of its rows in id order, each row rendered as the JSON array of
// its values in snapshotFields order exactly as PostgreSQL's
// json_build_array(...)::text writes it. The database computes it over
// staging and over the active rows with the SQL below; the bundle mirrors
// it for a verified backup and the tests, and the fixture suite asserts
// that both agree over a generated 30,000-row file.

// PostgreSQL separates array members with ", " and escapes strings exactly
// like JSON.stringify for text that holds no lone surrogate.
export const rowText = (row: SnapshotRow): string =>
  `[${row.map((value) => JSON.stringify(value)).join(', ')}]`;

const rowDigest = (row: SnapshotRow): string =>
  createHash('sha256').update(rowText(row), 'utf8').digest('hex');

export class SnapshotFingerprint {
  public rows = 0;
  readonly #hash = createHash('sha256');

  public add(row: SnapshotRow): void {
    this.#hash.update(rowDigest(row), 'utf8');
    this.rows += 1;
  }

  public digest(): string {
    return this.#hash.digest('hex');
  }
}

export const fingerprintOf = (rows: readonly SnapshotRow[]): string => {
  const fingerprint = new SnapshotFingerprint();
  for (const row of rows) {
    fingerprint.add(row);
  }
  return fingerprint.digest();
};

export const quotedFields = snapshotFields
  .map((field) => `"${field}"`)
  .join(', ');

// Count and fingerprint of the staged or the active snapshot, in one
// statement; the empty set fingerprints as sha256 of the empty text.
export const summarySql = (
  table: SnapshotTable,
): string => `SELECT COUNT(*)::integer AS "rows",
  encode(sha256(convert_to(COALESCE(string_agg(
    encode(sha256(convert_to(json_build_array(${quotedFields})::text, 'UTF8')), 'hex'),
    '' ORDER BY "id"), ''), 'UTF8')), 'hex') AS "fingerprint"
FROM "${table}"`;
