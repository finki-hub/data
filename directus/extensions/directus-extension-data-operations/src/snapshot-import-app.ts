import { defineOperationApp } from '@directus/extensions-sdk';

const text = (value: unknown): string =>
  typeof value === 'string' && value !== '' ? value : '--';

// Studio definition of the snapshot import operation; the API side is
// snapshot-import.ts.
export default defineOperationApp({
  description:
    'Stages a private Moodle snapshot CSV (administrators only): exact 38 headers, strict CSV, raw values unchanged, one transaction; answers { state: ready, rows, fingerprint } once committed. Never touches moodle_users.',
  icon: 'upload_file',
  id: 'finki-hub-snapshot-import',
  name: 'FINKI Hub snapshot import',
  options: [
    {
      field: 'file',
      meta: {
        interface: 'input',
        note: 'The id of the private CSV in the File Library (local storage), for example {{ $trigger.body.file }}.',
        required: true,
        width: 'full',
      },
      name: 'CSV file id',
      type: 'string',
    },
  ],
  overview: (options: Record<string, unknown>) => [
    { label: 'File', text: text(options['file']) },
  ],
});
