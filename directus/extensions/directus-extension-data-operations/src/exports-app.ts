import { defineOperationApp } from '@directus/extensions-sdk';

import { exportActions } from './exports/action-names.js';

const text = (value: unknown): string =>
  typeof value === 'string' && value !== '' ? value : '--';

// Studio definition of the export operation; the API side is
// exports-operation.ts, the published files are exports/index.ts.
export default defineOperationApp({
  description: `Public JSON files of the export definitions (administrators only). Actions: ${exportActions.join(', ')}. No upload.`,
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
        note: 'stage: claimed source revision, for example {{ claim.revision }}.',
        width: 'half',
      },
      name: 'Claimed revision',
      type: 'string',
    },
    {
      field: 'token',
      meta: {
        interface: 'input',
        note: 'stage: publication claim token, for example {{ claim.token }}.',
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
