import {
  condition,
  coordinateOperation,
  exportsOperation,
  flowFamilyCodes,
  type FlowTemplate,
  operation,
  publishId,
  raise,
} from './flow-template.js';
import {
  publishFileFlow,
  publishFileFlowId,
  publishStorage,
} from './publish-one-file.js';
import { refusal, step, claimToken as token } from './publish-steps.js';
import { flowDescription, stepName } from './text-fragments.js';
import { adminOnly } from './validate-readiness.js';

const family = flowFamilyCodes.publish;

export const publishAssetsFlowId = publishId('01');

// The manual publication of the public files. It claims publication (the
// button is the explicit request, so it retries a failed publication),
// then the export operation stages every declared file: readiness, the
// reads, the serialization and the validation of every payload before the
// first upload, and the source revision against the claim's. A serial
// Trigger Flow loop runs "Publish / One file" once per staged file in
// definition order; each answers its outcome and never stops the loop, so
// every file is attempted after a failure; each records its own outcome as
// it goes. The outcome map is recorded through complete when every file
// was uploaded (the claimed, prepared revision becomes published, and a
// source edit made meanwhile stays pending, answered as pendingRevision)
// and through fail otherwise (partial or failed). Which files exist is
// decided by the export definitions, never by this Flow; nothing is
// retried and nothing uploads in parallel.
export const publishAssetsFlow: FlowTemplate = {
  accountability: 'activity',
  description: flowDescription({
    adminOnly: true,
    does: `Uploads every declared public file to storage location "${publishStorage}", serially`,
    note: 'Outcome: completed, partial or failed',
  }),
  entry: publishId('11'),
  icon: 'cloud_upload',
  id: publishAssetsFlowId,
  name: 'Publish / Public assets',
  operations: [
    ...adminOnly(['11', '12', '13'], 'publish the public files', {
      code: family,
    }),
    step({
      column: 37,
      key: 'claim',
      name: 'Claim publication',
      next: '14',
      options: { action: 'claim', domain: 'publication', retry: true },
      reject: '1f',
      suffix: '13',
      type: coordinateOperation,
    }),
    raise({
      error: {
        code: 'PUBLICATION_CLAIM_FAILED',
        message: '{{ claim.message }}',
        status: 500,
      },
      family,
      key: 'raise_claim',
      name: stepName.raise('PUBLICATION_CLAIM_FAILED'),
      position: [37, 19],
      suffix: '1f',
    }),
    condition({
      edges: { reject: publishId('1a'), resolve: publishId('15') },
      family,
      filter: { claim: { claimed: { _eq: true } } },
      key: 'claimed',
      name: 'Claimed?',
      position: [55, 1],
      suffix: '14',
    }),
    raise({
      error: {
        code: 'PUBLICATION_NOT_CLAIMED',
        message: 'Publication not claimed: {{ claim.reason }}',
        status: 409,
      },
      family,
      key: 'raise_unclaimed',
      name: stepName.raise('PUBLICATION_NOT_CLAIMED'),
      position: [55, 19],
      suffix: '1a',
    }),
    step({
      column: 73,
      key: 'stage',
      name: 'Prepare and validate every file',
      next: '16',
      options: { action: 'stage', revision: '{{ claim.revision }}', token },
      reject: '1b',
      suffix: '15',
      type: exportsOperation,
    }),
    ...refusal({
      column: 73,
      error: { code: 'PUBLICATION_NOT_PREPARED', status: 409 },
      fail: { code: 'PREPARATION_REFUSED' },
      key: 'stage',
      message: '{{ stage.message }}',
      suffixes: ['1b', '1c'],
    }),
    step({
      column: 91,
      key: 'publish_files',
      name: 'Upload every file, one after another',
      next: '17',
      options: {
        flow: publishFileFlowId,
        iterationMode: 'serial',
        payload: '{{ stage.uploads }}',
      },
      reject: '1d',
      suffix: '16',
      type: 'trigger',
    }),
    ...refusal({
      column: 91,
      error: { code: 'PUBLICATION_LOOP_FAILED', status: 500 },
      fail: { code: 'PUBLISH_LOOP_FAILED' },
      key: 'publish_files',
      message: '{{ publish_files.message }}',
      suffixes: ['1d', '20'],
    }),
    step({
      column: 109,
      key: 'outcomes',
      name: 'Collect one outcome per file',
      next: '18',
      options: { action: 'outcomes', results: '{{ publish_files }}' },
      reject: '21',
      suffix: '17',
      type: exportsOperation,
    }),
    ...refusal({
      column: 109,
      error: { code: 'PUBLICATION_OUTCOMES_REFUSED', status: 500 },
      fail: { code: 'OUTCOMES_REFUSED' },
      key: 'outcomes',
      message: '{{ outcomes.message }}',
      suffixes: ['21', '22'],
    }),
    condition({
      edges: { reject: publishId('23'), resolve: publishId('19') },
      family,
      filter: { outcomes: { ok: { _eq: true } } },
      key: 'all_uploaded',
      name: 'Every file uploaded?',
      position: [127, 1],
      suffix: '18',
    }),
    operation({
      edges: { reject: publishId('24'), resolve: publishId('24') },
      family,
      key: 'record_failure',
      name: stepName.failClaim('uploads'),
      options: {
        action: 'fail',
        code: '{{ outcomes.code }}',
        files: '{{ outcomes.files }}',
        message: '{{ outcomes.message }}',
        token,
      },
      position: [127, 19],
      suffix: '23',
      type: coordinateOperation,
    }),
    raise({
      error: {
        code: '{{ outcomes.code }}',
        message: '{{ outcomes.message }}',
        status: 502,
      },
      family,
      key: 'raise_partial',
      name: stepName.raise('PUBLICATION_PARTIAL or PUBLICATION_FAILED'),
      position: [127, 37],
      suffix: '24',
    }),
    step({
      column: 145,
      key: 'complete',
      name: 'Record the publication',
      next: '1e',
      options: { action: 'complete', files: '{{ outcomes.files }}', token },
      reject: '25',
      suffix: '19',
      type: coordinateOperation,
    }),
    ...refusal({
      column: 145,
      error: { code: 'PUBLICATION_NOT_RECORDED', status: 409 },
      fail: { code: 'COMPLETION_REFUSED', files: '{{ outcomes.files }}' },
      key: 'complete',
      message: '{{ complete.message }}',
      suffixes: ['25', '26'],
    }),
    operation({
      family,
      key: 'answer',
      name: 'Answer the publication',
      options: {
        json: {
          files: '{{ outcomes.files }}',
          pendingRevision: '{{ complete.pendingRevision }}',
          published: true,
          revision: '{{ claim.revision }}',
          warnings: '{{ stage.warnings }}',
        },
      },
      position: [163, 1],
      suffix: '1e',
      type: 'transform',
    }),
  ],
  options: {
    async: false,
    collections: ['data_operations'],
    confirmationDescription: `Publish all public files to storage location "${publishStorage}", one after another?`,
    error_on_reject: true,
    location: 'both',
    requireConfirmation: true,
    requireSelection: false,
  },
  trigger: 'manual',
};

// The publish Flows in installation order: the child before the Flow that
// triggers it.
export const publishFlows: readonly FlowTemplate[] = [
  publishFileFlow,
  publishAssetsFlow,
];
