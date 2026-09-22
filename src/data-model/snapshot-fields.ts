import type { ModelField } from '../schema.js';

import { scalar } from './fields.js';

// The status of the controlled Moodle snapshot import and promotion,
// written only by the finki-hub-snapshot-import and -promote operations
// (Task 10) and appended after the coordination columns, so an installed
// project gains them additively. `import_state` itself is an original
// column of data_operations.
export const snapshotImportFields: readonly ModelField[] = [
  scalar('import_file', 'string', {
    note: 'Directus file id of the private CSV the last import staged.',
    readOnly: true,
  }),
  scalar('import_token', 'string', {
    note: 'Internal guard of the running import or promotion.',
    readOnly: true,
  }),
  scalar('import_rows', 'integer', {
    note: 'Rows of the staged snapshot.',
    readOnly: true,
  }),
  scalar('import_fingerprint', 'string', {
    note: 'sha256 fingerprint of the staged snapshot; the promotion must name it.',
    readOnly: true,
  }),
  scalar('import_warnings', 'text', {
    note: 'Flags of the staged snapshot, for example history lines the index cannot hold (row numbers only).',
    readOnly: true,
  }),
  scalar('import_error', 'text', {
    note: 'Code and message of the last failed import or promotion (row numbers and counts only).',
    readOnly: true,
  }),
  scalar('import_started_at', 'timestamp', { readOnly: true }),
  scalar('import_finished_at', 'timestamp', { readOnly: true }),
  scalar('import_backup_file', 'string', {
    note: 'Directus file id of the private CSV backup of the Moodle users the last promotion replaced; kept until deleted by hand.',
    readOnly: true,
  }),
  scalar('import_backup_rows', 'integer', { readOnly: true }),
  scalar('import_backup_fingerprint', 'string', { readOnly: true }),
  scalar('import_promoted_rows', 'integer', {
    note: 'Rows of the snapshot the last completed promotion made active; later imports never change it.',
    readOnly: true,
  }),
  scalar('import_promoted_fingerprint', 'string', {
    note: 'sha256 fingerprint of the snapshot the last completed promotion made active; active rows that no longer match it were changed outside the snapshot workflow.',
    readOnly: true,
  }),
  scalar('import_promoted_at', 'timestamp', { readOnly: true }),
];
