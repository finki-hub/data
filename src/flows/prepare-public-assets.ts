import {
  exportsOperation,
  flowFamilyCodes,
  type FlowTemplate,
  operation,
  publicationId,
} from './flow-template.js';
import { flowDescription } from './text-fragments.js';
import {
  adminOnly,
  publicationButton,
  validateReadinessFlow,
} from './validate-readiness.js';

const family = flowFamilyCodes.publication;

export const prepareAssetsFlowId = publicationId('05');

// A dry preparation of every public file: what a publication runs before
// its first upload, and no upload. The export operation checks readiness,
// reads, serializes and validates every file its definitions declare and
// checks the source revision again; the Flow answers its summary. Which
// files exist and what they hold is decided by the definitions in the
// data-operations extension, never by this Flow.
export const prepareAssetsFlow: FlowTemplate = {
  accountability: 'activity',
  description: flowDescription({
    adminOnly: true,
    answers: [
      'revision',
      'files: [{filename, rows, bytes, sha256}]',
      'warnings',
      'durationMs',
    ],
    does: 'Prepares every declared public file without uploading: readiness, read, serialize, validate, revision check',
  }),
  entry: publicationId('51'),
  icon: 'inventory',
  id: prepareAssetsFlowId,
  name: 'Publish / Prepare public assets',
  operations: [
    ...adminOnly(['51', '52', '53'], 'prepare the public assets'),
    operation({
      family,
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
