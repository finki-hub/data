import type { ModelField } from '../schema.js';

import { scalar } from './fields.js';

// The status columns of automatic processing (Task 13), appended after the
// snapshot columns so an installed project gains them additively. The
// input revisions are written by the source-invalidation trigger and by
// mark only; null (never written yet) reads as the source revision.
export const automaticProcessingFields: readonly ModelField[] = [
  scalar('last_error_message', 'text', {
    note: 'What the last failed or discarded run reported (ids and counts only, at most 600 characters).',
    readOnly: true,
  }),
  scalar('history_index_input_revision', 'integer', {
    note: 'Source revision of the last change to the inputs of the history index (Moodle users, entry deletions and labels, or a mark). A running index is overtaken only by a newer one.',
    readOnly: true,
  }),
  scalar('enrollments_input_revision', 'integer', {
    note: 'Source revision of the last change to the inputs of the enrollment counts (their tables, the history index inputs, or a mark). A running count is overtaken only by a newer one; a publication-only edit never is.',
    readOnly: true,
  }),
];
