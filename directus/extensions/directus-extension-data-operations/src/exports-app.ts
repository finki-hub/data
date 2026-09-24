import { defineOperationApp } from '@directus/extensions-sdk';

import { exportActions } from './exports/action-names.js';

const text = (value: unknown): string =>
  typeof value === 'string' && value !== '' ? value : '--';

// Studio definition of the export operation; the API side is
// exports-operation.ts, the published files are exports/index.ts.
export default defineOperationApp({
  description:
    'Checks, prepares and stages the public JSON files declared in the data-operations extension (administrators only): readiness answers ready, the source revision and issue counts; prepare reads, serializes and validates every file and answers its rows, bytes and sha256; stage does the same for the publication holding its claim and answers one upload per file; outcomes folds the publish loop answers into one outcome per file. Uploads nothing itself.',
  icon: 'inventory',
  id: 'finki-hub-exports',
  name: 'FINKI Hub public files',
  options: [
    {
      field: 'action',
      meta: {
        interface: 'select-dropdown',
        options: {
          allowNone: false,
          choices: exportActions.map((value) => ({ text: value, value })),
        },
        required: true,
        width: 'half',
      },
      name: 'Action',
      type: 'string',
    },
    {
      field: 'revision',
      meta: {
        interface: 'input',
        note: 'stage: the source revision of the publication claim, for example {{ claim.revision }}; the preparation is refused when the source moved since.',
        width: 'half',
      },
      name: 'Claimed revision',
      type: 'string',
    },
    {
      field: 'token',
      meta: {
        interface: 'input',
        note: 'stage: the publication claim token, for example {{ claim.token }}, handed to each file so its child keeps the claim alive.',
        width: 'half',
      },
      name: 'Claim token',
      type: 'string',
    },
    {
      field: 'results',
      meta: {
        interface: 'input-code',
        note: 'outcomes: the answers of the publish loop, for example {{ publish_files }}.',
        options: { language: 'json' },
        width: 'full',
      },
      name: 'Loop answers',
      type: 'json',
    },
  ],
  overview: (options: Record<string, unknown>) => [
    { label: 'Action', text: text(options['action']) },
  ],
});
