import type { ModelField } from '../schema.js';

import { scalar } from './fields.js';

// The status columns of automatic processing (Task 13). The input
// revisions are written by the source-invalidation trigger and by mark
// only; null (never written yet) reads as the source revision. Their labels
// are declared with the singleton's (operations-collections.ts).
export const automaticProcessingFields = [
  scalar('last_error_message', 'text', {
    note: 'What the last failed or discarded run reported (ids and counts only, at most 600 characters).',
    readOnly: true,
  }),
  scalar('history_index_input_revision', 'integer', {
    note: 'Source revision of the last change to the history index inputs (Moodle users, entry deletions and labels, or a mark).',
    readOnly: true,
  }),
  scalar('enrollments_input_revision', 'integer', {
    note: 'Source revision of the last change to the enrollment count inputs (their tables, the history index inputs, or a mark).',
    readOnly: true,
  }),
] satisfies readonly ModelField[];
