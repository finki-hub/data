import {
  condition,
  familyStep,
  flowFamilyCodes,
  type FlowTemplate,
  raise,
  snapshotId,
} from './flow-template.js';
import { snapshotFolder } from './snapshot-folder.js';

const family = flowFamilyCodes.snapshot;
export const snapshotImportOperation = 'finki-hub-snapshot-import';
export const snapshotPromoteOperation = 'finki-hub-snapshot-promote';
export const snapshotFlowId = snapshotId('01');

const step = familyStep(family);

const check = (spec: Omit<Parameters<typeof condition>[0], 'family'>) =>
  condition({ ...spec, family });

// A failure branch that answers the refusal of the operation it follows
// with that operation's own code, status and bounded message.
const relay = (
  spec: Omit<Parameters<typeof raise>[0], 'error' | 'family'> & {
    readonly from: string;
  },
) => {
  const { from, ...rest } = spec;
  return raise({
    ...rest,
    error: {
      code: `{{ ${from}.code }}`,
      message: `{{ ${from}.message }}`,
      status: `{{ ${from}.status }}`,
    },
    family,
  });
};

export const confirmationDescription =
  'Replace the WHOLE active Moodle snapshot (moodle_users) with the private CSV named below. Every Directus-only edit to Moodle users is replaced and the history memberships are cleared; course mappings, history entries, curricula, staff, students and every other maintained collection are never touched. Before anything is replaced, a verified private backup of the current Moodle users is written into the File Library folder "Moodle snapshots (private)" as "moodle-users-backup-<time>.csv"; restoring it is an explicit run of this Flow with that file. Upload the CSV into that folder first (local storage), then choose it below. History index, enrollment counts and publication become pending and are processed by their own runs.';

// The manual entry point on the data_operations singleton: an
// administrator names the uploaded CSV, confirms the replacement (and,
// separately, an empty snapshot), the import stages it and answers only
// once staging committed, and the promotion replaces the active snapshot
// under the coordinator's exclusive snapshot claim. Every refusal ends in
// a throw-error whose status, code and message say why.
export const snapshotImportFlow: FlowTemplate = {
  accountability: 'activity',
  description:
    'Imports a private Moodle snapshot CSV and replaces the active Moodle users with it (administrators only): exact headers, raw values, one staging transaction, a verified backup, one replacement transaction.',
  entry: snapshotId('11'),
  icon: 'upload_file',
  id: snapshotFlowId,
  name: 'Data / Import Moodle snapshot',
  operations: [
    check({
      edges: { reject: snapshotId('21'), resolve: snapshotId('12') },
      filter: { $accountability: { admin: { _eq: true } } },
      key: 'admin_only',
      name: 'Administrator?',
      position: [19, 1],
      suffix: '11',
    }),
    raise({
      error: {
        code: 'FORBIDDEN',
        message: 'Only administrators may import a Moodle snapshot.',
        status: 403,
      },
      family,
      key: 'raise_forbidden',
      name: 'Refuse a non-administrator',
      position: [19, 19],
      suffix: '21',
    }),
    check({
      edges: { reject: snapshotId('22'), resolve: snapshotId('13') },
      filter: { $trigger: { body: { confirm_replace: { _eq: true } } } },
      key: 'confirmed',
      name: 'Replacement confirmed?',
      position: [37, 1],
      suffix: '12',
    }),
    raise({
      error: {
        code: 'CONFIRMATION_REQUIRED',
        message:
          'Switch on "Replace the whole active Moodle snapshot" to import; nothing was staged or replaced.',
        status: 400,
      },
      family,
      key: 'raise_unconfirmed',
      name: 'Ask for the confirmation',
      position: [37, 19],
      suffix: '22',
    }),
    step({
      edges: { reject: snapshotId('23'), resolve: snapshotId('14') },
      key: 'import',
      name: 'Stage the private CSV',
      options: { file: '{{ $trigger.body.file }}' },
      position: [55, 1],
      suffix: '13',
      type: snapshotImportOperation,
    }),
    relay({
      from: 'import',
      key: 'import_failed',
      name: 'Report the refused import',
      position: [55, 19],
      suffix: '23',
    }),
    check({
      edges: { reject: snapshotId('24'), resolve: snapshotId('15') },
      filter: { import: { state: { _eq: 'ready' } } },
      key: 'staged',
      name: 'Staged and committed?',
      position: [73, 1],
      suffix: '14',
    }),
    raise({
      error: {
        code: 'IMPORT_NOT_READY',
        message:
          'The import answered without a ready staging; nothing was replaced.',
        status: 500,
      },
      family,
      key: 'raise_not_staged',
      name: 'Report a missing staging',
      position: [73, 19],
      suffix: '24',
    }),
    step({
      edges: { reject: snapshotId('25'), resolve: snapshotId('16') },
      key: 'promote',
      name: 'Replace the active snapshot',
      options: {
        allow_empty: '{{ $trigger.body.allow_empty }}',
        confirm_replace: '{{ $trigger.body.confirm_replace }}',
        staging_fingerprint: '{{ import.fingerprint }}',
      },
      position: [91, 1],
      suffix: '15',
      type: snapshotPromoteOperation,
    }),
    relay({
      from: 'promote',
      key: 'promote_failed',
      name: 'Report the refused promotion',
      position: [91, 19],
      suffix: '25',
    }),
    step({
      key: 'summary',
      name: 'Answer the run summary',
      options: {
        json: {
          backup: '{{ promote.backup }}',
          file: '{{ import.file }}',
          fingerprint: '{{ import.fingerprint }}',
          membershipsRemoved: '{{ promote.membershipsRemoved }}',
          pending: '{{ promote.pending }}',
          previousRows: '{{ promote.previousRows }}',
          revision: '{{ promote.revision }}',
          rows: '{{ promote.rows }}',
          state: '{{ promote.state }}',
          warnings: '{{ import.warnings }}',
        },
      },
      position: [109, 1],
      suffix: '16',
      type: 'transform',
    }),
  ],
  options: {
    async: false,
    collections: ['data_operations'],
    confirmationDescription,
    error_on_reject: true,
    fields: [
      {
        field: 'file',
        meta: {
          // The native item picker over the File Library: the dialog has
          // no relation to directus_files, so Studio's file interface
          // cannot keep a pick (Task 16 probe); the import accepts the
          // picked { key, collection } or a plain id.
          interface: 'collection-item-dropdown',
          note: `The CSV in the File Library folder "${snapshotFolder.name}": upload it there first, then choose it here.`,
          options: {
            filter: { folder: { _eq: snapshotFolder.id } },
            selectedCollection: 'directus_files',
            template: '{{ title }}',
          },
          required: true,
          width: 'full',
        },
        name: 'Private CSV file',
        type: 'json',
      },
      {
        field: 'confirm_replace',
        meta: { interface: 'boolean', width: 'full' },
        name: 'Replace the whole active Moodle snapshot',
        type: 'boolean',
      },
      {
        field: 'allow_empty',
        meta: { interface: 'boolean', width: 'full' },
        name: 'Allow an empty snapshot (removes every Moodle user)',
        type: 'boolean',
      },
    ],
    location: 'both',
    requireConfirmation: true,
    requireSelection: false,
  },
  trigger: 'manual',
};

export const snapshotImportFlows: readonly FlowTemplate[] = [
  snapshotImportFlow,
];
