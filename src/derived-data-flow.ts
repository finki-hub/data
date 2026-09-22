import { checkpointFlowId, type FlowTemplate } from './flows/flow-template.js';

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

// The checkpoint Rebuild derived data Flow the workbook import installs
// once under a stable id, so a later run recognises it and never resets
// what Studio changed in it. It keeps the checkpoint derivation working on
// a fresh import until its relational replacement lands.
export const derivedDataFlow: FlowTemplate = {
  accountability: 'activity',
  description:
    'Recalculates course exports and student council names from source collections.',
  entry: rebuildOperationId,
  icon: 'calculate',
  id: derivedDataFlowId,
  name: 'Rebuild derived data',
  operations: [
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
    location: 'collection',
    requireConfirmation: true,
    requireSelection: false,
  },
  trigger: 'manual',
};
