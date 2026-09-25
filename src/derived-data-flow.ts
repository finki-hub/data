import {
  checkpointFamilyCode,
  checkpointFlowId,
  type FlowTemplate,
} from './flows/flow-template.js';
import { adminOnly } from './flows/validate-readiness.js';

const sourceCollections = [
  'courses',
  'course_enrollment_patterns',
  'curriculum_2023',
  'curriculum_2018',
  'course_equivalencies',
  'teaching_assignments',
  'moodle_users',
  'students',
  'student_council',
] as const;

export const derivedDataFlowId = checkpointFlowId('01');

const rebuildOperationId = checkpointFlowId('11');

// The Administrator? gate, its refusal and the rebuild it lets through.
// The gate sits below the rebuild step, which keeps its place.
const gate = ['12', '13', '11'] as const;

// The checkpoint Rebuild derived data Flow the workbook import installs
// once under a stable id, so a later run recognises it and never resets
// what Studio changed in it. It keeps the checkpoint derivation working on
// a fresh import until its relational replacement lands. Anyone who may
// read one of its collections passes the trigger endpoint, so it refuses a
// non-administrator first (403), like every managed manual Flow; the
// import triggers it with the administrator token.
export const derivedDataFlow: FlowTemplate = {
  accountability: 'activity',
  description:
    'Recalculates course exports and student council names from source collections (administrators only).',
  entry: checkpointFlowId(gate[0]),
  icon: 'calculate',
  id: derivedDataFlowId,
  name: 'Rebuild derived data',
  operations: [
    ...adminOnly(gate, 'Only administrators may rebuild the derived data.', {
      at: [19, 19],
      code: checkpointFamilyCode,
    }),
    {
      id: rebuildOperationId,
      key: 'rebuild_derived_data',
      name: 'Rebuild derived data',
      options: {},
      position_x: 19,
      position_y: 1,
      reject: null,
      resolve: null,
      type: 'finki-hub-rebuild-derived-data',
    },
  ],
  options: {
    async: false,
    collections: sourceCollections,
    error_on_reject: true,
    location: 'collection',
    requireConfirmation: true,
    requireSelection: false,
  },
  trigger: 'manual',
};
