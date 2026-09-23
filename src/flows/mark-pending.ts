import {
  automationId,
  condition,
  coordinateOperation,
  flowFamilyCodes,
  type FlowTemplate,
  operation,
  raise,
} from './flow-template.js';

const family = flowFamilyCodes.automation;

export const markPendingFlowId = automationId('03');

// The domains a request names in the confirmation dialog, or the two
// calculation domains when it names none (a REST call without a body).
// The coordinator validates the names.
export const chosenDomainsScript = `module.exports = function (data) {
  const body = data.$trigger !== null && typeof data.$trigger === 'object' ? data.$trigger.body : null;
  const chosen = body !== null && typeof body === 'object' && Array.isArray(body.domains) ? body.domains : [];
  return chosen.length > 0 ? chosen : ['history_index', 'enrollments'];
};`;

// The explicit recalculation request, and the explicit retry of a failed
// run: it marks the chosen domains pending, which moves the source
// revision like an edit would, so a failure recorded at the old revision
// no longer holds the domain back. It runs nothing itself: the scheduled
// "Data / Process pending" claims the work at its next tick, through the
// one claim path every run takes. Marking is not the consistency boundary
// either; the statement-level source triggers mark every edit inside its
// own transaction whether or not anyone presses this.
export const markPendingFlow: FlowTemplate = {
  accountability: 'activity',
  description:
    'Asks for a recalculation (administrators only): marks the chosen domains pending (history index and enrollment counts by default), which also retries a failed run, and answers the status. It runs nothing itself: "Data / Process pending" claims the work at its next tick (every 15 seconds) and runs it; Data Operations shows pending, running, failed and current per domain.',
  entry: automationId('51'),
  icon: 'update',
  id: markPendingFlowId,
  name: 'Data / Mark pending',
  operations: [
    // Any user who may read data_operations could trigger a manual Flow on
    // it; marking moves the source revision, so it is gated on the
    // administrator flag like every data operation.
    condition({
      edges: { reject: automationId('55'), resolve: automationId('52') },
      family,
      filter: { $accountability: { admin: { _eq: true } } },
      key: 'admin_only',
      name: 'Administrator?',
      position: [19, 1],
      suffix: '51',
    }),
    raise({
      error: {
        code: 'FORBIDDEN',
        message: 'Only administrators may ask for a recalculation.',
        status: 403,
      },
      family,
      key: 'raise_forbidden',
      name: 'Refuse a non-administrator',
      position: [19, 19],
      suffix: '55',
    }),
    operation({
      edges: { resolve: automationId('53') },
      family,
      key: 'domains',
      name: 'Chosen domains',
      options: { code: chosenDomainsScript },
      position: [37, 1],
      suffix: '52',
      type: 'exec',
    }),
    operation({
      edges: { reject: automationId('56'), resolve: automationId('54') },
      family,
      key: 'mark',
      name: 'Mark the domains pending',
      options: { action: 'mark', domains: '{{ domains }}' },
      position: [55, 1],
      suffix: '53',
      type: coordinateOperation,
    }),
    raise({
      error: {
        code: 'MARK_REFUSED',
        message: '{{ mark.message }}',
        status: 400,
      },
      family,
      key: 'raise_mark',
      name: 'Report the refused request',
      position: [55, 19],
      suffix: '56',
    }),
    operation({
      edges: { resolve: automationId('57') },
      family,
      key: 'status',
      name: 'Read the status',
      options: { action: 'status' },
      position: [73, 1],
      suffix: '54',
      type: coordinateOperation,
    }),
    operation({
      family,
      key: 'answer',
      name: 'Answer what was marked',
      options: {
        json: {
          dirty: '{{ mark.domains }}',
          domains: '{{ status.domains }}',
          next: 'Data / Process pending claims the work at its next tick (every 15 seconds) and runs it.',
          revision: '{{ mark.revision }}',
        },
      },
      position: [91, 1],
      suffix: '57',
      type: 'transform',
    }),
  ],
  options: {
    async: false,
    collections: ['data_operations'],
    confirmationDescription:
      'Mark these domains pending? The scheduled Flow recalculates them within about 15 seconds plus the run time. Marking also retries a run that failed at the current source revision.',
    error_on_reject: true,
    fields: [
      {
        field: 'domains',
        meta: {
          interface: 'select-multiple-checkbox',
          options: {
            choices: [
              { text: 'Moodle history index', value: 'history_index' },
              { text: 'Enrollment counts', value: 'enrollments' },
              { text: 'Publication', value: 'publication' },
            ],
          },
          width: 'full',
        },
        name: 'Domains (history index and enrollment counts when none)',
        type: 'json',
      },
    ],
    location: 'both',
    requireConfirmation: true,
    requireSelection: false,
  },
  trigger: 'manual',
};
