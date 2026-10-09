import type { ModelField } from '../schema.js';

import { scalar } from './fields.js';

// The status of the controlled Moodle snapshot import and promotion,
// written only by the finki-hub-snapshot-import and -promote operations
// (Task 10). `import_state` itself is declared beside `publication_state`
// in operations-collections.ts, which labels every field of the singleton.
export const snapshotImportFields = [
  scalar('import_file', 'string', { readOnly: true }),
  scalar('import_token', 'string', { readOnly: true }),
  scalar('import_rows', 'integer', { readOnly: true }),
  scalar('import_fingerprint', 'string', { readOnly: true }),
  scalar('import_warnings', 'text', { readOnly: true }),
  scalar('import_error', 'text', { readOnly: true }),
  scalar('import_started_at', 'timestamp', { readOnly: true }),
  scalar('import_finished_at', 'timestamp', { readOnly: true }),
  scalar('import_backup_file', 'string', {
    note: 'Kept until deleted by hand.',
    readOnly: true,
  }),
  scalar('import_backup_rows', 'integer', { readOnly: true }),
  scalar('import_backup_fingerprint', 'string', { readOnly: true }),
  scalar('import_promoted_rows', 'integer', { readOnly: true }),
  scalar('import_promoted_fingerprint', 'string', {
    note: 'Active rows that no longer match it were changed outside the snapshot import.',
    readOnly: true,
  }),
  scalar('import_promoted_at', 'timestamp', { readOnly: true }),
] satisfies readonly ModelField[];
