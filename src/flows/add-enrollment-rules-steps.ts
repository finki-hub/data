import {
  failureRecord,
  familyStep,
  flowFamilyCodes,
  type FlowTemplate,
  raise,
  rulesId,
} from './flow-template.js';
import { flowDescription, stepName } from './text-fragments.js';

// The steps of "Data / Add enrollment rules": its batch child, a refusal
// step and a read of its scope.

const family = flowFamilyCodes.rules;
const step = familyStep(family);

export const ruleSeedingBatchFlowId = rulesId('02');

export const rulesCollection = 'course_enrollment_rules';

// One serial batch: a native Create of at most ruleBatchSize rules, which
// answers { ok: true, created: [ids] } or, when the Create is refused (the
// unique (course, academic_year) index backs the idempotence up), a
// failure record with its code, so the loop goes on and the parent
// reports which batch failed.
export const ruleSeedingBatchFlow: FlowTemplate = {
  accountability: 'activity',
  description: flowDescription({
    answers: ['ok: true', 'created'],
    caller: 'Data / Add enrollment rules',
    does: 'Creates the enrollment rules of one batch (the trigger payload) with one native Create',
    failure: {},
  }),
  entry: rulesId('31'),
  icon: 'playlist_add',
  id: ruleSeedingBatchFlowId,
  name: 'Data / Add enrollment rules batch',
  operations: [
    step({
      edges: { reject: rulesId('33'), resolve: rulesId('32') },
      key: 'create',
      name: 'Create the rules of this batch',
      options: {
        collection: rulesCollection,
        emitEvents: false,
        payload: '{{ $trigger }}',
        permissions: '$trigger',
      },
      position: [19, 1],
      suffix: '31',
      type: 'item-create',
    }),
    step({
      key: 'created',
      name: 'Answer the created ids',
      options: { json: { created: '{{ create }}', ok: true } },
      position: [37, 1],
      suffix: '32',
      type: 'transform',
    }),
    step({
      key: 'refused',
      name: stepName.answerFailure('create'),
      options: failureRecord({ stage: 'create' }),
      position: [19, 19],
      suffix: '33',
      type: 'transform',
    }),
  ],
  options: { return: '$last' },
  trigger: 'operation',
};

// A Throw Error step under the step it answers for, named by its code.
export const refusal = (
  spec: Pick<Parameters<typeof raise>[0], 'key' | 'suffix'> & {
    readonly code: string;
    readonly column: number;
    readonly message: string;
    readonly status: number;
  },
) =>
  raise({
    error: { code: spec.code, message: spec.message, status: spec.status },
    family,
    key: spec.key,
    name: stepName.raise(spec.code),
    position: [spec.column, 19],
    suffix: spec.suffix,
  });

// A read of the scope with the permissions of whoever runs the Flow
// ($trigger), and the refusal it rejects to (Directus keeps every resolve
// and reject target unique, so each step has its own).
export const scopeRead = (spec: {
  readonly collection: string;
  readonly column: number;
  readonly fields: readonly string[];
  readonly filter: string;
  readonly key: string;
  readonly name: string;
  readonly next: string;
  readonly refusal: string;
  readonly suffix: string;
}) => [
  step({
    edges: { reject: rulesId(spec.refusal), resolve: rulesId(spec.next) },
    key: spec.key,
    name: spec.name,
    options: {
      collection: spec.collection,
      permissions: '$trigger',
      query: {
        fields: [...spec.fields],
        filter: spec.filter,
        limit: -1,
        sort: [spec.fields[0] ?? 'id'],
      },
    },
    position: [spec.column, 1],
    suffix: spec.suffix,
    type: 'item-read',
  }),
  refusal({
    code: 'RULES_READ_FAILED',
    column: spec.column,
    key: `${spec.key}_failed`,
    message: `{{ ${spec.key}.message }}`,
    status: 500,
    suffix: spec.refusal,
  }),
];
