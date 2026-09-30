import { adminOnlyText } from '../../directus/extensions/directus-extension-data-operations/src/text.js';
import {
  pairsScript,
  ruleSeedingOptions,
  scopeScript,
  tallyScript,
} from './add-enrollment-rules-scripts.js';
import {
  refusal,
  rulesCollection,
  ruleSeedingBatchFlow,
  ruleSeedingBatchFlowId,
  scopeRead,
} from './add-enrollment-rules-steps.js';
import {
  condition,
  familyStep,
  flowFamilyCodes,
  type FlowTemplate,
  rulesId,
} from './flow-template.js';
import { mappedRuleMode } from './shared.js';
import { flowDescription } from './text-fragments.js';

const family = flowFamilyCodes.rules;
const step = familyStep(family);

export const ruleSeedingFlowId = rulesId('01');

// The explicit, idempotent seeding of enrollment rules for a new academic
// year or course (owner decision 2026-09-23): no event Flow runs it. It
// refuses a non-administrator before any read (the trigger endpoint only
// checks read access to data_operations), reads the year and course ids in
// scope and their existing rules with native Reads, computes the missing
// pairs in a small Script and creates them in serial batches of native
// Creates with the declared mapped mode. Existing pairs (of any mode) are
// skipped, so a rerun creates nothing; it never changes a rule and never
// creates a mapping. The new rules mark the enrollment counts pending
// through the source triggers, and Data / Process pending counts them.
export const ruleSeedingFlow: FlowTemplate = {
  accountability: 'activity',
  description: flowDescription({
    adminOnly: true,
    does: `Creates missing enrollment rules (mode ${mappedRuleMode.mode}) for an academic year, a course or one pair`,
    note: 'Existing rules are skipped',
  }),
  entry: rulesId('11'),
  icon: 'playlist_add',
  id: ruleSeedingFlowId,
  name: 'Data / Add enrollment rules',
  operations: [
    condition({
      edges: { reject: rulesId('21'), resolve: rulesId('12') },
      family,
      filter: { $accountability: { admin: { _eq: true } } },
      key: 'admin_only',
      name: 'Administrator?',
      position: [19, 1],
      suffix: '11',
    }),
    refusal({
      code: 'FORBIDDEN',
      column: 19,
      key: 'raise_forbidden',
      message: adminOnlyText('add enrollment rules'),
      status: 403,
      suffix: '21',
    }),
    step({
      edges: { reject: rulesId('22'), resolve: rulesId('13') },
      key: 'scope',
      name: 'Resolve the scope',
      options: { code: scopeScript },
      position: [37, 1],
      suffix: '12',
      type: 'exec',
    }),
    refusal({
      code: 'RULES_SCOPE_INVALID',
      column: 37,
      key: 'raise_scope',
      message: '{{ scope.message }}',
      status: 400,
      suffix: '22',
    }),
    ...scopeRead({
      collection: 'academic_years',
      column: 55,
      fields: ['id'],
      filter: '{{ scope.years }}',
      key: 'years',
      name: 'Read the academic years in scope',
      next: '14',
      refusal: '23',
      suffix: '13',
    }),
    ...scopeRead({
      collection: 'courses',
      column: 73,
      fields: ['id'],
      filter: '{{ scope.courses }}',
      key: 'courses',
      name: 'Read the courses in scope',
      next: '15',
      refusal: '26',
      suffix: '14',
    }),
    ...scopeRead({
      collection: rulesCollection,
      column: 91,
      fields: ['course', 'academic_year'],
      filter: '{{ scope.rules }}',
      key: 'rules',
      name: 'Read their existing rules',
      next: '16',
      refusal: '27',
      suffix: '15',
    }),
    step({
      edges: { reject: rulesId('24'), resolve: rulesId('17') },
      key: 'pairs',
      name: 'List the missing pairs',
      options: { code: pairsScript },
      position: [109, 1],
      suffix: '16',
      type: 'exec',
    }),
    refusal({
      code: 'RULES_SCOPE_UNKNOWN',
      column: 109,
      key: 'raise_pairs',
      message: '{{ pairs.message }}',
      status: 404,
      suffix: '24',
    }),
    step({
      edges: { reject: rulesId('25'), resolve: rulesId('18') },
      key: 'create_batches',
      name: 'Create the batches, one after another',
      options: {
        flow: ruleSeedingBatchFlowId,
        iterationMode: 'serial',
        payload: '{{ pairs.batches }}',
      },
      position: [127, 1],
      suffix: '17',
      type: 'trigger',
    }),
    refusal({
      code: 'RULES_BATCH_FAILED',
      column: 127,
      key: 'raise_loop',
      message: '{{ create_batches.message }}',
      status: 500,
      suffix: '25',
    }),
    step({
      edges: { reject: rulesId('28'), resolve: rulesId('19') },
      key: 'tally',
      name: 'Count the created rules',
      options: { code: tallyScript },
      position: [145, 1],
      suffix: '18',
      type: 'exec',
    }),
    refusal({
      code: 'RULES_BATCH_FAILED',
      column: 145,
      key: 'raise_batches',
      message: '{{ tally.message }}',
      status: 409,
      suffix: '28',
    }),
    step({
      key: 'answer',
      name: 'Answer what was created',
      options: {
        json: {
          batches: '{{ tally.batches }}',
          courses: '{{ pairs.courses }}',
          created: '{{ tally.created }}',
          existing: '{{ pairs.existing }}',
          mode: mappedRuleMode.mode,
          years: '{{ pairs.years }}',
        },
      },
      position: [163, 1],
      suffix: '19',
      type: 'transform',
    }),
  ],
  options: ruleSeedingOptions,
  trigger: 'manual',
};

// The family in installation order: the batch child before its parent.
export const enrollmentRuleFlows: readonly FlowTemplate[] = [
  ruleSeedingBatchFlow,
  ruleSeedingFlow,
];
