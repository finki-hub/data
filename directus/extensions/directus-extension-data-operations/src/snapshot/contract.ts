import { z } from 'zod';

import { blank, flag } from '../coordination/options.js';

// The 38 scraper fields of a Moodle snapshot: exactly the columns that
// moodle_users and its staging twin moodle_import_rows carry besides the
// native id. A snapshot CSV names each of them once, in any order, and
// nothing else. test/snapshot-import.test.ts keeps this list equal to the
// data model.
export const snapshotFields = [
  'ID_old',
  'ID_new',
  'Name',
  'Mail',
  'Courses',
  'Courses Count',
  'Profile_old',
  'Profile_new',
  'AIM_new',
  'AIM_old',
  'Avatar_new',
  'Avatar_old',
  'City_new',
  'City_old',
  'Country_new',
  'Country_old',
  'Description_new',
  'Description_old',
  'ICQ_new',
  'ICQ_old',
  'Images_new',
  'Images_old',
  'Interests_new',
  'Interests_old',
  'Last Access_new',
  'Last Access_old',
  'MSN_new',
  'MSN_old',
  'MoodleNet_new',
  'MoodleNet_old',
  'Skype_new',
  'Skype_old',
  'Timezone_new',
  'Timezone_old',
  'Web_new',
  'Web_old',
  'Yahoo_new',
  'Yahoo_old',
] as const;

export type SnapshotField = (typeof snapshotFields)[number];

// One staged row: every snapshot field, in snapshotFields order.
export type SnapshotRow = readonly SnapshotValue[];

export type SnapshotValue = null | number | string;

// The two Moodle instances' user ids. Each is validated on its own: a
// populated id is a positive integer, unique inside its own column; the
// old and the new instance are never matched with each other.
export const instanceIdFields = ['ID_old', 'ID_new'] as const;

export const integerFields: readonly SnapshotField[] = [
  'ID_old',
  'ID_new',
  'Courses Count',
];

export const requiredFields: readonly SnapshotField[] = ['Name'];

export const historyField: SnapshotField = 'Courses';

// Columns Directus created as varchar(255); PostgreSQL counts their
// length in characters (code points).
export const boundedFields: readonly SnapshotField[] = snapshotFields.filter(
  (field) =>
    ![
      'Avatar_new',
      'Avatar_old',
      'Courses',
      'Description_new',
      'Description_old',
      'Images_new',
      'Images_old',
      'Interests_new',
      'Interests_old',
      'Profile_new',
      'Profile_old',
      'Web_new',
      'Web_old',
      ...integerFields,
    ].includes(field),
);

export const boundedLength = 255;

export const maxInteger = 2_147_483_647;

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
// CSV only from it and every backup is written into it, so one permission
// filter on it keeps any files-reading role away from the snapshot files.
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

// The import operation takes the private Directus file id and nothing
// else: never a path, a URL or CSV text.
export const importOptionsSchema = z.object({
  file: z.preprocess(blank, z.uuid()),
});

export type ImportOptions = z.infer<typeof importOptionsSchema>;

export const fingerprintPattern = /^[\da-f]{64}$/u;

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
