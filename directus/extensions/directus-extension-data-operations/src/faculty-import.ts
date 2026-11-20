import { defineOperationApi } from '@directus/extensions-sdk';

import { sqlDatabase } from './coordinate.js';
import { httpFacultyFeed, runFacultyImport } from './faculty/import.js';

export const facultyImportId = 'finki-hub-faculty-import';

// Imports the faculty structure and the staff profiles from the public
// pages of finki.ukim.mk (FACULTY_SITE_URL overrides the site) and matches
// the people to staff. Run by Data / Import faculty structure (daily and by
// hand).
export default defineOperationApi({
  handler: (_options, { database, env }) => {
    const site: unknown = env['FACULTY_SITE_URL'];
    return runFacultyImport(
      sqlDatabase(database),
      typeof site === 'string' && site !== ''
        ? httpFacultyFeed(site)
        : httpFacultyFeed(),
    );
  },
  id: facultyImportId,
});
