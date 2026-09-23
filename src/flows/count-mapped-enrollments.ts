import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DirectusRequest } from '../directus-request.js';

import { mappedPageFlow } from './count-mapped-enrollment-page.js';
import { coordinateOperation, type FlowTemplate } from './flow-template.js';
import {
  type FlowInstallSummary,
  installFlowTemplates,
} from './install-flows.js';
import {
  countFailure,
  enrollmentId,
  mappedEnrollmentFlowIds,
  enrollmentStep as step,
} from './shared.js';

// The Run Script body of the pair Flow, kept as a plain file so it can be
// read and edited as JavaScript; the template installs its exact text.
export const countScriptPath = join(
  import.meta.dirname,
  '..',
  '..',
  'directus',
  'flows',
  'count-mapped-enrollments.cjs',
);

const countScript = await readFile(countScriptPath, 'utf8');

// COUNT(DISTINCT moodle_users.id) over the users whose history memberships
// carry an entry with a mapping to exactly this course AND this academic
// year. On Directus 12.3.1 the two sibling conditions become one AND over a
// single LEFT JOIN chain (one alias per relational path), so both apply to
// the same mapping row; `_some` is deliberately absent: with two conditions
// inside it the engine drops the whole filter, and two separate `_some`
// blocks match a course of one mapping and a year of another
// (docs/progress/evidence/relational-redesign/task-11/00-relation-filter-probe.log).
export const mappedCountQuery = {
  aggregate: { countDistinct: ['id'] },
  filter: {
    history_memberships: {
      entry: {
        mappings: {
          academic_year: { _eq: '{{ $trigger.academic_year }}' },
          course: { _eq: '{{ $trigger.course }}' },
        },
      },
    },
  },
} as const;

const pairContext = {
  academic_year: '{{ $trigger.academic_year }}',
  course: '{{ $trigger.course }}',
};

// One course/year of an enrollment claim. The claim is checked first (a
// heartbeat, which also keeps a long page alive), then the native aggregate
// is read and validated. The Flow writes nothing: the page Flow stages the
// results of all its pairs at once. It logs activity only, like every
// business Flow, and Directus writes one `run` activity row per run: an
// enrollment run adds one row per mapped rule, which only Directus
// retention (RETENTION_ENABLED, FLOW_LOGS_RETENTION) prunes (README).
export const mappedPairFlow: FlowTemplate = {
  accountability: 'activity',
  description:
    'Counts one course/year from explicit history mappings. Input {course, academic_year, revision, claim}: heartbeats the enrollment claim, reads COUNT(DISTINCT id) of the Moodle users with a history entry mapped to exactly that course and academic year on one mapping row, and answers {course, academic_year, count, revision}; a zero is a real count. Any failure answers {ok: false, stage, code, message} instead, never a zero. Writes nothing; called serially by "Data / Count mapped enrollment page".',
  entry: enrollmentId('11'),
  icon: 'functions',
  id: mappedEnrollmentFlowIds.pair,
  name: 'Data / Count mapped enrollments',
  operations: [
    step({
      edges: { reject: enrollmentId('14'), resolve: enrollmentId('12') },
      key: 'check_claim',
      name: 'Check the enrollment claim',
      options: { action: 'heartbeat', token: '{{ $trigger.claim }}' },
      position: [19, 1],
      suffix: '11',
      type: coordinateOperation,
    }),
    step({
      edges: { reject: enrollmentId('15'), resolve: enrollmentId('13') },
      key: 'read_count',
      name: 'Count distinct mapped Moodle users',
      options: {
        collection: 'moodle_users',
        emitEvents: false,
        permissions: '$full',
        query: mappedCountQuery,
      },
      position: [37, 1],
      suffix: '12',
      type: 'item-read',
    }),
    step({
      edges: { reject: enrollmentId('16') },
      key: 'shape_count',
      name: 'Validate and shape the count',
      options: { code: countScript },
      position: [55, 1],
      suffix: '13',
      type: 'exec',
    }),
    step({
      key: 'claim_failed',
      name: 'Record the claim failure',
      options: countFailure('claim', pairContext),
      position: [19, 19],
      suffix: '14',
      type: 'transform',
    }),
    step({
      key: 'read_failed',
      name: 'Record the read failure',
      options: countFailure('read', pairContext),
      position: [37, 19],
      suffix: '15',
      type: 'transform',
    }),
    step({
      key: 'shape_failed',
      name: 'Record the invalid aggregate',
      options: countFailure('validate', pairContext, 'INVALID_AGGREGATE'),
      position: [55, 19],
      suffix: '16',
      type: 'transform',
    }),
  ],
  options: { return: '$last' },
  trigger: 'operation',
};

// The pair Flow before the page Flow that calls it.
export const mappedEnrollmentFlows: readonly FlowTemplate[] = [
  mappedPairFlow,
  mappedPageFlow,
];

// Installs the mapped enrollment Flows once each; a Flow whose id exists
// keeps every Studio edit (see installFlowTemplates).
export const installMappedEnrollmentFlows = (
  request: DirectusRequest,
): Promise<FlowInstallSummary> =>
  installFlowTemplates(request, mappedEnrollmentFlows);
