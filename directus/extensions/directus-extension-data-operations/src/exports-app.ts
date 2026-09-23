import { defineOperationApp } from '@directus/extensions-sdk';

const text = (value: unknown): string =>
  typeof value === 'string' && value !== '' ? value : '--';

// Studio definition of the export operation; the API side is
// exports-operation.ts, the published files are exports/index.ts.
export default defineOperationApp({
  description:
    'Checks and prepares the public JSON files declared in the data-operations extension (administrators only): readiness answers ready, the source revision and issue counts; prepare reads, serializes and validates every file and answers its rows, bytes and sha256. Uploads nothing.',
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
          choices: [
            { text: 'readiness', value: 'readiness' },
            { text: 'prepare', value: 'prepare' },
          ],
        },
        required: true,
        width: 'half',
      },
      name: 'Action',
      type: 'string',
    },
  ],
  overview: (options: Record<string, unknown>) => [
    { label: 'Action', text: text(options['action']) },
  ],
});
