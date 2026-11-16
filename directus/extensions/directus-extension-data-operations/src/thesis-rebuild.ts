import { defineHook } from '@directus/extensions-sdk';

import type { SqlDatabase } from './coordination/sql-port.js';

import { sqlDatabase } from './coordinate.js';
import {
  type Log,
  logOf,
  rebuildScheduler,
  teachingEvents,
} from './teaching-rebuild.js';
import { rebuildCommittee } from './theses/import.js';

// The collections thesis_committee is matched against: an item written
// through Directus to either rebuilds it after the write committed. The
// thesis import rebuilds it itself.
export const thesisInputs = ['staff', 'staff_aliases'] as const;

export const registerThesisRebuild = (
  action: (event: string, handler: () => void) => void,
  database: SqlDatabase,
  log: Log,
): void => {
  const schedule = rebuildScheduler(
    () => database.transaction((client) => rebuildCommittee(client)),
    log,
    'Thesis committee',
  );
  for (const collection of thesisInputs) {
    for (const event of teachingEvents) {
      action(`${collection}.items.${event}`, () => {
        void schedule();
      });
    }
  }
};

export default defineHook(({ action }, { database, logger }) => {
  registerThesisRebuild(action, sqlDatabase(database), logOf(logger));
});
