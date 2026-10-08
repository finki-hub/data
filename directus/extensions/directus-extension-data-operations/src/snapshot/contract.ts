import { z } from 'zod';

import { blank, flag } from '../coordination/options.js';

export type SnapshotFieldDeclaration = {
  readonly field: string;
  readonly kind: SnapshotKind;
  readonly required?: true;
};

// How a scraper field is stored in moodle_users and its staging twin:
// `string` is a varchar(255), whose length PostgreSQL counts in
// characters (code points); `text` is unbounded; `integer` is an int4.
type SnapshotKind = 'integer' | 'string' | 'text';

// The scraper fields of a Moodle snapshot, declared once: exactly the
// columns that moodle_users and its staging twin moodle_import_rows carry
// besides the native id (src/data-model/moodle-collections.ts declares
// them from this table), in this order. A snapshot CSV names each of them
// once, in any order, and nothing else; the header set is a fixed
// contract with the scraper, never an import option.
export const snapshotFieldTable = [
  { field: 'ID_old', kind: 'integer' },
  { field: 'ID_new', kind: 'integer' },
  { field: 'Name', kind: 'string', required: true },
  { field: 'Mail', kind: 'string' },
  { field: 'Courses', kind: 'text' },
  { field: 'Courses Count', kind: 'integer' },
  { field: 'Profile_old', kind: 'text' },
  { field: 'Profile_new', kind: 'text' },
  { field: 'AIM_new', kind: 'string' },
  { field: 'AIM_old', kind: 'string' },
  { field: 'Avatar_new', kind: 'text' },
  { field: 'Avatar_old', kind: 'text' },
  { field: 'City_new', kind: 'string' },
  { field: 'City_old', kind: 'string' },
  { field: 'Country_new', kind: 'string' },
  { field: 'Country_old', kind: 'string' },
  { field: 'Description_new', kind: 'text' },
  { field: 'Description_old', kind: 'text' },
  { field: 'ICQ_new', kind: 'string' },
  { field: 'ICQ_old', kind: 'string' },
  { field: 'Images_new', kind: 'text' },
  { field: 'Images_old', kind: 'text' },
  { field: 'Interests_new', kind: 'text' },
  { field: 'Interests_old', kind: 'text' },
  { field: 'Last Access_new', kind: 'string' },
  { field: 'Last Access_old', kind: 'string' },
  { field: 'MSN_new', kind: 'string' },
  { field: 'MSN_old', kind: 'string' },
  { field: 'MoodleNet_new', kind: 'string' },
  { field: 'MoodleNet_old', kind: 'string' },
  { field: 'Skype_new', kind: 'string' },
  { field: 'Skype_old', kind: 'string' },
  { field: 'Timezone_new', kind: 'string' },
  { field: 'Timezone_old', kind: 'string' },
  { field: 'Web_new', kind: 'text' },
  { field: 'Web_old', kind: 'text' },
  { field: 'Yahoo_new', kind: 'string' },
  { field: 'Yahoo_old', kind: 'string' },
] as const satisfies readonly SnapshotFieldDeclaration[];

export type SnapshotField = (typeof snapshotFieldTable)[number]['field'];

const fieldsWhere = (
  kept: (declaration: SnapshotFieldDeclaration) => boolean,
): readonly SnapshotField[] =>
  snapshotFieldTable.filter(kept).map(({ field }) => field);

export const snapshotFields: readonly SnapshotField[] = snapshotFieldTable.map(
  ({ field }) => field,
);

// One staged row: every snapshot field, in snapshotFields order.
export type SnapshotRow = readonly SnapshotValue[];

export type SnapshotValue = null | number | string;

// The two Moodle instances' user ids. Each is validated on its own: a
// populated id is a positive integer, unique inside its own column; the
// old and the new instance are never matched with each other.
export const instanceIdFields = ['ID_old', 'ID_new'] as const;

export const integerFields = fieldsWhere(({ kind }) => kind === 'integer');

export const requiredFields = fieldsWhere(({ required }) => required === true);

export const historyField: SnapshotField = 'Courses';

// The varchar(255) columns.
export const boundedFields = fieldsWhere(({ kind }) => kind === 'string');

export const boundedLength = 255;

export const maxInteger = 2_147_483_647;

const positiveIdPattern = /^[1-9]\d*$/u;

// A populated instance id as both snapshot paths accept it (the CSV import
// and the workbook's Courses sheet): a positive int4, written without a
// sign, a fraction or leading zeros.
export const isPositiveId = (text: string): boolean =>
  positiveIdPattern.test(text) && Number(text) <= maxInteger;

// The import states are declared once with the coordinator's other
// vocabularies (coordination/domains.ts).

export const stagingTable = 'moodle_import_rows';
export const activeTable = 'moodle_users';

// Bounds of one import. The byte bound defaults to 256 MiB and may be set
// with FINKI_HUB_SNAPSHOT_MAX_BYTES; the deadline is Directus' own
// IMPORT_TIMEOUT (default 1h). Nothing is ever buffered whole: the file is
// parsed as a stream and staged in batches.
export const defaultMaxBytes = 256 * 1_024 * 1_024;
export const maxBytesVariable = 'FINKI_HUB_SNAPSHOT_MAX_BYTES';
export const timeoutVariable = 'IMPORT_TIMEOUT';
export const defaultTimeoutMs = 60 * 60 * 1_000;
export const maxFieldChars = 8 * 1_024 * 1_024;
export const maxRows = 1_000_000;
// A staging batch holds at most batchRows rows and is sent as soon as its
// cells reach batchChars characters, so a batch of very long cells stays
// small however large the file is (its JSON text is at most six times
// that, for control characters escaped as \u00XX).
export const batchRows = 250;
export const batchChars = 4 * 1_024 * 1_024;
export const backupBatchRows = 500;
// How often a promotion refreshes its claim's heartbeat while it writes
// and verifies the backup; the claim goes stale after 60 s of silence.
export const heartbeatEveryMs = 10_000;

// The private File Library folder of the workflow, which npm run setup
// creates with this id (src/flows/snapshot-folder.ts): the import reads a
// CSV only from it and every backup is written into it.
export const snapshotFolderId = '6a1d9f0e-2b3c-4d5e-8f70-0000000010f0';
export const snapshotFolderName = 'Moodle snapshots (private)';

// Types a browser or Directus may report for a .csv upload.
export const csvTypes: readonly string[] = [
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'text/plain',
];

const units: Readonly<Record<string, number>> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  ms: 1,
  s: 1_000,
};

const durationPattern = /^(?<amount>\d+)\s*(?<unit>[dhms]|ms)?$/u;

// IMPORT_TIMEOUT as Directus writes it ("1h", "10m", "30s") or a number of
// milliseconds; anything else falls back to the Directus default.
export const durationMs = (value: unknown): number => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  const match = typeof value === 'string' ? durationPattern.exec(value) : null;
  const amount = Number(match?.groups?.['amount'] ?? NaN);
  const unit = units[match?.groups?.['unit'] ?? 'ms'] ?? 1;
  return Number.isSafeInteger(amount) && amount > 0
    ? amount * unit
    : defaultTimeoutMs;
};

export const byteLimit = (value: unknown): number => {
  const parsed = z.coerce.number().int().positive().safeParse(value);
  return parsed.success ? parsed.data : defaultMaxBytes;
};

// The file as the Flow's dialog picks it: Studio's item picker over the
// File Library answers { key, collection: 'directus_files' }; a REST
// caller may send the id itself. Any other collection is refused.
const pickedFile = z
  .object({
    collection: z.literal('directus_files'),
    key: z.unknown(),
  })
  .transform(({ key }) => key);

const fileId = (value: unknown): unknown => {
  const picked = pickedFile.safeParse(value);
  return blank(picked.success ? picked.data : value);
};

// The import operation takes the private Directus file id and nothing
// else: never a path, a URL or CSV text.
export const importOptionsSchema = z.object({
  file: z.preprocess(fileId, z.uuid()),
});

const fingerprintPattern = /^[\da-f]{64}$/u;

// The promotion needs the replacement confirmed, the fingerprint of the
// staged snapshot it was shown, and, for an empty snapshot, a separate
// explicit confirmation.
export const promoteOptionsSchema = z.object({
  allow_empty: z
    .preprocess(flag, z.boolean().optional())
    .transform((value) => value ?? false),
  confirm_replace: z.preprocess(flag, z.literal(true)),
  staging_fingerprint: z.preprocess(
    blank,
    z.string().regex(fingerprintPattern),
  ),
});

export type PromoteOptions = z.infer<typeof promoteOptionsSchema>;
