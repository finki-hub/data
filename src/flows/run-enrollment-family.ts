import {
  automationId,
  condition,
  coordinateOperation,
  flowFamilyCodes,
  type FlowTemplate,
  operation,
} from './flow-template.js';
import {
  failStepId,
  type ReleaseBranch,
  releaseSteps,
} from './release-steps.js';
import { flowDescription } from './text-fragments.js';

const family = flowFamilyCodes.automation;

export const familyRunnerFlowId = automationId('04');

// The code a family fails its claim with when its runner could not run it
// (the claim was lost, the runner Flow is missing or answered no record).
export const familyFailureCode = 'ENROLLMENTS_FAILED';

// The Trigger Flow target of the runner: the runner Flow the planner named
// for this family (rule-modes.ts). Directus 12.3.1 renders the `flow`
// option like every other option, so the one installed step serves every
// declared mode; Studio shows the template text in its Flow picker.
const familyRunnerTarget = '{{ $trigger.runner }}';

const release = (
  spec: Omit<ReleaseBranch, 'code' | 'family' | 'token'>,
): ReleaseBranch => ({
  ...spec,
  code: familyFailureCode,
  family,
  token: '{{ $trigger.claim }}',
});

// Every way a family can end without counting. A family runner fails the
// claim itself with its own code, so the fail here finds the claim
// released and keeps that code; it fails the claim itself only when the
// runner could not, and a later family then refuses at its heartbeat
// without running. A runner's own failure record is forwarded as it is
// (its stage, code and message), so the dispatcher relays it once.
const branches = {
  heartbeat: release({
    message: '{{ keep_alive.message }}',
    position: [19, 19],
    recordCode: '{{ keep_alive.code }}',
    stage: 'heartbeat',
    suffixes: ['71', '72'],
  }),
  refused: release({
    message: '{{ run.message }}',
    position: [73, 19],
    recordCode: '{{ run.code }}',
    recordStage: '{{ run.stage }}',
    stage: 'family',
    suffixes: ['75', '76'],
  }),
  run: release({
    message: '{{ run.message }}',
    position: [37, 19],
    recordCode: '{{ run.code }}',
    stage: 'run',
    suffixes: ['73', '74'],
  }),
  silent: release({
    message:
      'Runner Flow {{ $trigger.runner }}: no answer (inactive or deleted)',
    position: [55, 37],
    stage: 'runner',
    suffixes: ['77', '78'],
  }),
} as const;

// One family of an enrollments plan ({claim, kind, pages, revision,
// runner}, as the dispatcher lists it): the claim is refreshed, the
// family's runner Flow runs it, and the runner's answer becomes the
// family's. No step names a rule mode or a runner, so the dispatcher graph
// stays the same whichever modes are declared.
export const familyRunnerFlow: FlowTemplate = {
  accountability: 'activity',
  description: flowDescription({
    answers: ['kind', 'ok: true', 'summary'],
    caller: 'Data / Count enrollments',
    does: `Runs one family of an enrollments plan through the runner Flow the plan names (${familyRunnerTarget})`,
    failure: { codes: [familyFailureCode] },
    input: ['claim', 'kind', 'pages', 'revision', 'runner'],
  }),
  entry: automationId('61'),
  icon: 'account_tree',
  id: familyRunnerFlowId,
  name: 'Data / Run enrollment family',
  operations: [
    operation({
      edges: {
        reject: failStepId(branches.heartbeat),
        resolve: automationId('62'),
      },
      family,
      key: 'keep_alive',
      name: 'Refresh the claim',
      options: { action: 'heartbeat', token: '{{ $trigger.claim }}' },
      position: [19, 1],
      suffix: '61',
      type: coordinateOperation,
    }),
    operation({
      edges: { reject: failStepId(branches.run), resolve: automationId('63') },
      family,
      key: 'run',
      name: 'Run the family through its runner Flow',
      options: {
        flow: familyRunnerTarget,
        iterationMode: 'serial',
        payload: '{{ $trigger }}',
      },
      position: [37, 1],
      suffix: '62',
      type: 'trigger',
    }),
    condition({
      edges: { reject: automationId('65'), resolve: automationId('64') },
      family,
      filter: { run: { ok: { _eq: true } } },
      key: 'ran',
      name: 'Family counted?',
      position: [55, 1],
      suffix: '63',
    }),
    operation({
      family,
      key: 'answer',
      name: 'Answer the family summary',
      options: {
        json: { kind: '{{ $trigger.kind }}', ok: true, summary: '{{ run }}' },
      },
      position: [73, 1],
      suffix: '64',
      type: 'transform',
    }),
    condition({
      edges: {
        reject: failStepId(branches.silent),
        resolve: failStepId(branches.refused),
      },
      family,
      filter: { run: { ok: { _eq: false } } },
      key: 'refused',
      name: 'Family refused?',
      position: [55, 19],
      suffix: '65',
    }),
    ...Object.values(branches).flatMap((branch) => releaseSteps(branch)),
  ],
  options: { return: '$last' },
  trigger: 'operation',
};
