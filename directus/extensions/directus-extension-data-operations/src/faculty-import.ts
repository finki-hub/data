import { defineOperationApi } from '@directus/extensions-sdk';

import { sqlDatabase } from './coordinate.js';
import { httpFacultyFeed, runLoggedFacultyImport } from './faculty/import.js';
import { logOf } from './teaching-rebuild.js';

export const facultyImportId = 'finki-hub-faculty-import';

// Imports the faculty structure and the staff profiles from the public
// pages of finki.ukim.mk (FACULTY_SITE_URL overrides the site) and matches
// the people to staff. Run by Data / Import faculty structure (daily and by
// hand).
export default defineOperationApi({
  handler: (_options, { database, env, logger }) => {
    const site: unknown = env['FACULTY_SITE_URL'];
    return runLoggedFacultyImport(
      sqlDatabase(database),
      typeof site === 'string' && site !== ''
        ? httpFacultyFeed(site)
        : httpFacultyFeed(),
      logOf(logger),
    );
  },
  id: facultyImportId,
});
