import {
  exportsOperation,
  flowFamilyCodes,
  type FlowTemplate,
  operation,
  publicationId,
} from './flow-template.js';
import { flowDescription } from './text-fragments.js';

const family = flowFamilyCodes.publication;

export const validateReadinessFlowId = publicationId('04');

// The manual Flows of the publication family share these options: a
// button on the hidden Data Operations singleton that answers the last
// step, or its refusal with its status and code.
export const publicationButton = {
  async: false,
  collections: ['data_operations'],
  error_on_reject: true,
  location: 'both',
  requireConfirmation: false,
  requireSelection: false,
} as const;

// The readiness check on demand. Its logic lives in the export operation
// (the same code the preparation runs first), so this Flow only calls it;
// it holds no coordinator step and reads nothing itself.
export const validateReadinessFlow: FlowTemplate = {
  accountability: 'activity',
  description: flowDescription({
    answers: [
      'ready',
      'revision',
      'blockers',
      'warnings',
      'issueCounts',
      'links',
      'reviews',
      'blockedFiles',
    ],
    does: 'Checks publication readiness: history index and enrollment counts current, no Moodle snapshot import running or failed, every declared readiness check',
  }),
  entry: publicationId('43'),
  icon: 'fact_check',
  id: validateReadinessFlowId,
  name: 'Data / Validate readiness',
  operations: [
    operation({
      family,
      key: 'readiness',
      name: 'Validate readiness',
      options: { action: 'readiness' },
      position: [19, 1],
      suffix: '43',
      type: exportsOperation,
    }),
  ],
  options: publicationButton,
  trigger: 'manual',
};
