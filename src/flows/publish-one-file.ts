import {
  coordinateOperation,
  flowFamilyCodes,
  type FlowTemplate,
  operation,
  publishId,
  publishJsonOperation,
} from './flow-template.js';

const family = flowFamilyCodes.publish;

export const publishFileFlowId = publishId('02');

const filename = '{{ $trigger.filename }}';
const claim = '{{ $trigger.claim }}';

// The storage location every file is written to: Directus's `publish` S3
// location (STORAGE_LOCATIONS). It is an ordinary option of the upload
// step, editable in Studio like the rest of the Flow.
const publishStorage = 'publish';

// One published file, run by the publish loop of "Publish / Public assets
// (relational)" once per upload the export operation staged, in
// definition order. It keeps the publication claim alive (a heartbeat that
// leases the claim for the upload), hands the file's single-entry objects
// map to the existing storage writer, and records the file's outcome with
// the coordinator at once, so a run that stops before its end still shows
// every file it uploaded. It never rejects: every step that can fail has a
// branch that answers {ok, filename, outcome, code}, so the serial loop
// goes on to the next file after a failure and the parent sees one answer
// per file. A claim that cannot be kept skips the upload (another run may
// hold publication now), with the heartbeat's code.
export const publishFileFlow: FlowTemplate = {
  accountability: 'activity',
  description:
    'Uploads one public file for "Publish / Public assets (relational)", which runs it once per declared file, one after another: keeps the publication claim alive, writes the file through the Publish JSON files operation into the publish storage location, and records its outcome in Data Operations right away. Answers {ok, filename, outcome, code} and never fails the loop: a refused upload answers its code and the next file is still uploaded. Not meant to be run on its own.',
  entry: publishId('51'),
  icon: 'upload_file',
  id: publishFileFlowId,
  name: 'Publish / One file',
  operations: [
    operation({
      edges: { reject: publishId('55'), resolve: publishId('52') },
      family,
      key: 'keep_claim',
      name: 'Keep the publication claim',
      options: { action: 'heartbeat', token: claim },
      position: [19, 1],
      suffix: '51',
      type: coordinateOperation,
    }),
    operation({
      edges: { reject: publishId('57'), resolve: publishId('56') },
      family,
      key: 'upload',
      name: 'Upload the file',
      options: { objects: '{{ $trigger.objects }}', storage: publishStorage },
      position: [37, 1],
      suffix: '52',
      type: publishJsonOperation,
    }),
    // Recording answers the upload whether or not the record succeeds (a
    // claim recovered meanwhile refuses it; the upload happened all the
    // same).
    operation({
      edges: { reject: publishId('53'), resolve: publishId('53') },
      family,
      key: 'record_uploaded',
      name: 'Record the upload',
      options: {
        action: 'record',
        bytes: '{{ upload.bytes }}',
        filename,
        outcome: 'uploaded',
        token: claim,
      },
      position: [55, 1],
      suffix: '56',
      type: coordinateOperation,
    }),
    operation({
      family,
      key: 'uploaded',
      name: 'Answer the upload',
      options: {
        json: {
          bytes: '{{ upload.bytes }}',
          code: null,
          filename,
          ok: true,
          outcome: 'uploaded',
        },
      },
      position: [73, 1],
      suffix: '53',
      type: 'transform',
    }),
    operation({
      edges: { reject: publishId('54'), resolve: publishId('54') },
      family,
      key: 'record_failed',
      name: 'Record the refused upload',
      options: {
        action: 'record',
        code: '{{ upload.code }}',
        filename,
        outcome: 'failed',
        token: claim,
      },
      position: [55, 19],
      suffix: '57',
      type: coordinateOperation,
    }),
    operation({
      family,
      key: 'upload_failed',
      name: 'Answer the refused upload',
      options: {
        json: {
          bytes: null,
          code: '{{ upload.code }}',
          filename,
          message: '{{ upload.message }}',
          ok: false,
          outcome: 'failed',
        },
      },
      position: [73, 19],
      suffix: '54',
      type: 'transform',
    }),
    operation({
      family,
      key: 'claim_lost',
      name: 'Answer the lost claim',
      options: {
        json: {
          bytes: null,
          code: '{{ keep_claim.code }}',
          filename,
          message: '{{ keep_claim.message }}',
          ok: false,
          outcome: 'skipped',
        },
      },
      position: [19, 19],
      suffix: '55',
      type: 'transform',
    }),
  ],
  options: { return: '$last' },
  trigger: 'operation',
};
