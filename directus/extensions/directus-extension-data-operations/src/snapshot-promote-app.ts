import { defineOperationApp } from '@directus/extensions-sdk';

const text = (value: unknown): string =>
  typeof value === 'string' && value !== '' ? value : '--';

// Studio definition of the snapshot promotion operation; the API side is
// snapshot-promote.ts.
export default defineOperationApp({
  description:
    'Replaces moodle_users with the staged snapshot (administrators only): exclusive claim, verified backup, one transaction; marks history_index, enrollments and publication pending.',
  icon: 'published_with_changes',
  id: 'finki-hub-snapshot-promote',
  name: 'FINKI Hub snapshot promotion',
  options: [
    {
      field: 'staging_fingerprint',
      meta: {
        interface: 'input',
        note: 'The fingerprint the import answered, for example {{ import.fingerprint }}.',
        required: true,
        width: 'full',
      },
      name: 'Staged fingerprint',
      type: 'string',
    },
    {
      field: 'confirm_replace',
      meta: {
        interface: 'input',
        note: 'Must be true, for example {{ $trigger.body.confirm_replace }}.',
        width: 'half',
      },
      name: 'Replacement confirmed',
      type: 'string',
    },
    {
      field: 'allow_empty',
      meta: {
        interface: 'input',
        note: 'True only to replace the active users with an empty snapshot, for example {{ $trigger.body.allow_empty }}.',
        width: 'half',
      },
      name: 'Empty snapshot confirmed',
      type: 'string',
    },
  ],
  overview: (options: Record<string, unknown>) => [
    { label: 'Fingerprint', text: text(options['staging_fingerprint']) },
  ],
});
