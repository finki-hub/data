import type { ModelField } from '../schema.js';

import { scalar } from './fields.js';

// The status columns of automatic processing (Task 13). The input
// revisions are written by the source-invalidation trigger and by mark
// only; null (never written yet) reads as the source revision. Their labels
// are declared with the singleton's (operations-collections.ts).
export const automaticProcessingFields = [
  scalar('last_error_message', 'text', { readOnly: true }),
  scalar('history_index_input_revision', 'integer', { readOnly: true }),
  scalar('enrollments_input_revision', 'integer', { readOnly: true }),
] satisfies readonly ModelField[];
