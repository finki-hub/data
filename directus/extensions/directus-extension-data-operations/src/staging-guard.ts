import { defineHook } from '@directus/extensions-sdk';

import { stagingTable } from './snapshot/contract.js';
import { snapshotError } from './snapshot/errors.js';

export const stagingEvents = ['create', 'update', 'delete'] as const;

// The refusal every Directus item write to the snapshot staging gets.
export const stagingRefusal = () =>
  snapshotError(
    'STAGING_GUARDED',
    'moodle_import_rows is the staging of the controlled Moodle snapshot import; only the "Data / Import Moodle snapshot" Flow writes it. Upload the CSV to the File Library and run that Flow.',
  );

// Refuses every item write on the staging table through Directus (Studio,
// REST, GraphQL, the native CSV/JSON import, Flows that emit events) with
// a readable 403 before any statement runs. The import operation never
// uses the items service: it writes with raw SQL inside its own
// transaction, after setting the transaction-local marker
// finki_hub.snapshot_writer, which the database guard of the
// schema-constraints migration requires of every other writer as well.
export const registerStagingGuard = (
  filter: (event: string, handler: () => never) => void,
): void => {
  for (const event of stagingEvents) {
    filter(`${stagingTable}.items.${event}`, () => {
      throw stagingRefusal();
    });
  }
};

export default defineHook(({ filter }) => {
  registerStagingGuard(filter);
});
