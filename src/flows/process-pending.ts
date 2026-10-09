import type { CalculationDomain } from '../../directus/extensions/directus-extension-data-operations/src/coordination/domains.js';

import {
  dispatcherFlow,
  dispatcherFlowId,
  enrollmentsFailureCode,
} from './count-enrollments.js';
import {
  automationId,
  condition,
  coordinateOperation,
  flowFamilyCodes,
  type FlowTemplate,
  operation,
} from './flow-template.js';
import { refreshFlow } from './index-histories.js';
import { markPendingFlow } from './mark-pending.js';
import {
  branch,
  type CalculationRoute,
  missingBranch,
  routeSteps,
  unknownDomainSteps,
} from './process-routes.js';
import { flowDescription, stepName } from './text-fragments.js';

const family = flowFamilyCodes.automation;

export const processPendingFlowId = automationId('02');

// Every 15 seconds: the schedule's six-field cron (seconds first) on
// Directus 12.3.1. `0 */15 * * * *` would be every 15 minutes.
export const processPendingCron = '*/15 * * * * *';

const claimToken = '{{ claim.token }}';

// One explicit route per declared calculation domain, keyed by the domain
// so a new calculation domain names its child here or does not compile.
// Each child releases the claim itself (complete or fail); the scheduler
// fails it only when the child could not.
const calculationRoutes: Readonly<Record<CalculationDomain, CalculationRoute>> =
  {
    enrollments: {
      answered: { key: 'counted', suffix: '39' },
      child: dispatcherFlowId,
      crashed: branch({
        code: enrollmentsFailureCode,
        message: '{{ count.message }}',
        position: [73, 73],
        stage: 'enrollments_run',
        suffixes: ['45', '46'],
      }),
      missing: missingBranch(dispatcherFlow.name, {
        code: enrollmentsFailureCode,
        position: [91, 73],
        stage: 'enrollments_missing',
        suffixes: ['47', '48'],
      }),
      payload: { claim: claimToken, revision: '{{ claim.revision }}' },
      route: {
        key: 'route_enrollments',
        name: 'Enrollment counts?',
        suffix: '3a',
      },
      row: 55,
      run: { key: 'count', name: 'Count enrollments', suffix: '38' },
    },
    history_index: {
      answered: { key: 'refreshed', suffix: '35' },
      child: refreshFlow.id,
      crashed: branch({
        code: 'INDEX_FAILED',
        message: '{{ refresh.message }}',
        position: [73, 19],
        stage: 'history_run',
        suffixes: ['41', '42'],
      }),
      missing: missingBranch(refreshFlow.name, {
        code: 'INDEX_FAILED',
        position: [91, 19],
        stage: 'history_missing',
        suffixes: ['43', '44'],
      }),
      payload: { claim: claimToken },
      route: { key: 'route', name: 'History index?', suffix: '33' },
      row: 1,
      run: { key: 'refresh', name: 'Refresh the history index', suffix: '34' },
    },
  };

// The native scheduler of automatic processing. Every tick goes through
// the coordinator's atomic claim, which also releases a claim whose
// heartbeat went stale: with the default in-memory synchronization every
// Directus process fires every tick and a long run overlaps the next ones,
// so the claim is the only guard. An idle tick (busy, nothing pending,
// upstream dirty, or a failure at this revision) reads the status row and
// the Flow graph and ends at `idle`; it reads no collection. A claimed
// tick runs exactly one domain, the first pending one in dependency order
// (the history index before the enrollment counts; publication never,
// that is the publish Flow's), through the child that completes or fails
// the claim; the next tick takes the next domain. A failure stays failed
// until an edit, Mark pending or a graph change: no timed retry. The
// schedule has no caller and no accountability, so every item read in the
// children names its permissions ($full) explicitly.
export const processPendingFlow: FlowTemplate = {
  accountability: 'activity',
  description: flowDescription({
    does: `Claims the first pending calculation domain every 15 seconds (history index, then enrollment counts) and runs "${refreshFlow.name}" or "${dispatcherFlow.name}"; one domain per tick`,
    note: `A failed domain stays failed until a source edit, "${markPendingFlow.name}" or a Flow graph change`,
  }),
  entry: automationId('31'),
  icon: 'schedule',
  id: processPendingFlowId,
  name: 'Data / Process pending',
  operations: [
    operation({
      edges: { reject: automationId('36'), resolve: automationId('32') },
      family,
      key: 'claim',
      name: 'Claim the next pending calculation',
      options: { action: 'claim', domain: 'next_calculation' },
      position: [19, 1],
      suffix: '31',
      type: coordinateOperation,
    }),
    operation({
      family,
      key: 'claim_failed',
      name: stepName.answerFailure('claim'),
      options: {
        json: {
          claimed: false,
          code: '{{ claim.code }}',
          message: '{{ claim.message }}',
          stage: 'claim',
        },
      },
      position: [19, 19],
      suffix: '36',
      type: 'transform',
    }),
    condition({
      edges: { reject: automationId('37'), resolve: automationId('33') },
      family,
      filter: { claim: { claimed: { _eq: true } } },
      key: 'claimed',
      name: 'Claimed?',
      position: [37, 1],
      suffix: '32',
    }),
    operation({
      family,
      key: 'idle',
      name: 'Answer idle',
      options: { json: { claimed: false, reason: '{{ claim.reason }}' } },
      position: [37, 19],
      suffix: '37',
      type: 'transform',
    }),
    ...routeSteps(calculationRoutes),
    ...unknownDomainSteps(),
  ],
  options: { cron: processPendingCron },
  trigger: 'schedule',
};

// The automatic processing Flows in installation order: every child before
// the Flows that call it, the schedule last, so its first tick finds them.
// The dispatcher's page Flow belongs to the matching family, installed
// before this one.
export const automaticProcessingFlows: readonly FlowTemplate[] = [
  dispatcherFlow,
  markPendingFlow,
  processPendingFlow,
];
