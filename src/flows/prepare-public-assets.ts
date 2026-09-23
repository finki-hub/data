import type { DirectusRequest } from '../directus-request.js';

import {
  exportsOperation,
  type FlowTemplate,
  operation,
  publicationId,
} from './flow-template.js';
import {
  type FlowInstallSummary,
  installFlowTemplates,
} from './install-flows.js';
import {
  adminOnly,
  publicationButton,
  validateReadinessFlow,
} from './validate-readiness.js';

export const prepareAssetsFlowId = publicationId('05');

// A dry preparation of every public file: what a publication runs before
// its first upload, and no upload. The export operation checks readiness,
// reads, serializes and validates every file its definitions declare and
// checks the source revision again; the Flow answers its summary. Which
// files exist and what they hold is decided by the definitions in the
// data-operations extension, never by this Flow.
export const prepareAssetsFlow: FlowTemplate = {
  accountability: 'activity',
  description:
    'Dry preparation of the public files (administrators only); uploads nothing. Checks readiness, then for every file the export definitions of the data-operations extension declare, in their order: reads the relational data with explicit fields, serializes and validates the payload; then checks the source revision again. Answers the revision and the name, rows, bytes and sha256 of each file; refuses when not ready or when the source changed meanwhile.',
  entry: publicationId('51'),
  icon: 'inventory',
  id: prepareAssetsFlowId,
  name: 'Publish / Prepare public assets',
  operations: [
    ...adminOnly(
      ['51', '52', '53'],
      'Only administrators may prepare the public assets.',
    ),
    operation({
      family: '14',
      key: 'prepare',
      name: 'Prepare every public file',
      options: { action: 'prepare' },
      position: [37, 1],
      suffix: '53',
      type: exportsOperation,
    }),
  ],
  options: publicationButton,
  trigger: 'manual',
};

// The publication Flows in installation order.
export const publicationFlows: readonly FlowTemplate[] = [
  validateReadinessFlow,
  prepareAssetsFlow,
];

// Installs the publication Flows once each; a Flow whose id exists keeps
// every Studio edit (see installFlowTemplates).
export const installPublicationFlows = (
  request: DirectusRequest,
): Promise<FlowInstallSummary> =>
  installFlowTemplates(request, publicationFlows);
