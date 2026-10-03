import {
  calculationDomains,
  domainDeclarations,
  domainLabel,
} from '../../directus/extensions/directus-extension-data-operations/src/coordination/domains.js';
import {
  automationId,
  coordinateOperation,
  flowFamilyCodes,
  type FlowTemplate,
  operation,
  raise,
} from './flow-template.js';
import { flowDescription, stepName } from './text-fragments.js';

const family = flowFamilyCodes.automation;

export const markPendingFlowId = automationId('03');

const quoted = (value: string): string => `'${value}'`;

// The calculation domains as a script literal, in declaration order.
const calculationList = `[${calculationDomains.map(quoted).join(', ')}]`;

// The domains a request without a choice marks, by their labels.
const defaultDomains = calculationDomains.map(domainLabel).join(', ');

// The domains a request names in the confirmation dialog, or the declared
// calculation domains when it names none (a REST call without a body).
// The coordinator validates the names.
export const chosenDomainsScript = `module.exports = function (data) {
  const body = data.$trigger !== null && typeof data.$trigger === 'object' ? data.$trigger.body : null;
  const chosen = body !== null && typeof body === 'object' && Array.isArray(body.domains) ? body.domains : [];
  return chosen.length > 0 ? chosen : ${calculationList};
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
  description: flowDescription({
    does: `Marks the selected domains pending (default: ${defaultDomains}); retries a failed run`,
  }),
  entry: automationId('52'),
  icon: 'update',
  id: markPendingFlowId,
  name: 'Data / Mark pending',
  operations: [
    operation({
      edges: { resolve: automationId('53') },
      family,
      key: 'domains',
      name: 'Resolve the domains',
      options: { code: chosenDomainsScript },
      position: [19, 1],
      suffix: '52',
      type: 'exec',
    }),
    operation({
      edges: { reject: automationId('56'), resolve: automationId('54') },
      family,
      key: 'mark',
      name: 'Mark the domains pending',
      options: { action: 'mark', domains: '{{ domains }}' },
      position: [37, 1],
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
      name: stepName.raise('MARK_REFUSED'),
      position: [37, 19],
      suffix: '56',
    }),
    operation({
      edges: { resolve: automationId('57') },
      family,
      key: 'status',
      name: 'Read the status',
      options: { action: 'status' },
      position: [55, 1],
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
          revision: '{{ mark.revision }}',
        },
      },
      position: [73, 1],
      suffix: '57',
      type: 'transform',
    }),
  ],
  options: {
    async: false,
    collections: ['data_operations'],
    confirmationDescription: 'Mark the selected domains pending?',
    error_on_reject: true,
    fields: [
      {
        field: 'domains',
        meta: {
          interface: 'select-multiple-checkbox',
          note: `Default: ${defaultDomains}.`,
          // One choice per declared domain, with its label.
          options: {
            choices: domainDeclarations.map(({ label, name }) => ({
              text: label,
              value: name,
            })),
          },
          width: 'full',
        },
        name: 'Domains',
        type: 'json',
      },
    ],
    location: 'both',
    requireConfirmation: true,
    requireSelection: false,
  },
  trigger: 'manual',
};
