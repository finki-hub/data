import { defineHook } from '@directus/extensions-sdk';

import type { SqlDatabase } from './coordination/sql-port.js';

import { sqlDatabase } from './coordinate.js';
import { rebuildTeaching } from './teaching/import.js';

// The collections course_teaching and the slots are matched against: an
// item written through Directus to any of them rebuilds them (and the
// lessons' match columns) after the write committed. The timetable import rebuilds it
// itself.
export const teachingInputs = [
  'course_aliases',
  'staff_aliases',
  'room_aliases',
  'rooms',
  'courses',
  'staff',
  'curriculum_entries',
  'course_curricula',
] as const;

export const teachingEvents = ['create', 'update', 'delete'] as const;

export type Log = { readonly error: (message: string) => void };

// Rebuilds once for any number of writes that arrive while a rebuild runs:
// one rebuild runs at a time and at most one more is queued. A failure is
// logged as the rebuild of `what`.
export const rebuildScheduler = (
  rebuild: () => Promise<unknown>,
  log: Log,
  what = 'Course teaching',
): (() => Promise<void>) => {
  let running: null | Promise<void> = null;
  let queued = false;
  const start = (): Promise<void> => {
    running = (async () => {
      try {
        await rebuild();
      } catch (error) {
        log.error(
          `${what} rebuild failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        running = null;
      }
      if (!queued) {
        return;
      }

      queued = false;
      await start();
    })();
    return running;
  };
  return () => {
    if (running !== null) {
      queued = true;
      return running;
    }
    return start();
  };
};

export const registerTeachingRebuild = (
  action: (event: string, handler: () => void) => void,
  database: SqlDatabase,
  log: Log,
): void => {
  const schedule = rebuildScheduler(
    () => database.transaction((client) => rebuildTeaching(client)),
    log,
  );
  for (const collection of teachingInputs) {
    for (const event of teachingEvents) {
      action(`${collection}.items.${event}`, () => {
        void schedule();
      });
    }
  }
};

// The Directus logger, narrowed to the one call this hook makes; without
// one a failed rebuild goes to the console.
export const logOf = (candidate: unknown): Log =>
  typeof candidate === 'object' &&
  candidate !== null &&
  'error' in candidate &&
  typeof candidate.error === 'function'
    ? (candidate as Log)
    : console;

export default defineHook(({ action }, { database, logger }) => {
  registerTeachingRebuild(action, sqlDatabase(database), logOf(logger));
});
