import { defineOperationApi } from '@directus/extensions-sdk';

import { sqlDatabase } from './coordinate.js';
import {
  defaultTimetablesApi,
  httpSource,
  runTimetableImport,
} from './teaching/import.js';

export const timetableImportId = 'finki-hub-timetable-import';

// Imports the timetables from the timetables API (TIMETABLES_API_URL, by
// default timetables-api.finki-hub.com) and rebuilds course_teaching. Run
// by Data / Import timetables (daily and by hand).
export default defineOperationApi({
  handler: (options, { database, env }) => {
    const base =
      typeof env['TIMETABLES_API_URL'] === 'string' &&
      env['TIMETABLES_API_URL'] !== ''
        ? env['TIMETABLES_API_URL']
        : defaultTimetablesApi;
    return runTimetableImport(options, sqlDatabase(database), httpSource(base));
  },
  id: timetableImportId,
});
