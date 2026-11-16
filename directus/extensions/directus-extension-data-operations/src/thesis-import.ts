import { defineOperationApi } from '@directus/extensions-sdk';

import { sqlDatabase } from './coordinate.js';
import {
  defaultBachelorsApi,
  defaultMastersApi,
  httpThesisSource,
  runThesisImport,
} from './theses/import.js';

export const thesisImportId = 'finki-hub-thesis-import';

const setting = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value !== '' ? value : fallback;

// Imports the theses from the theses APIs (BACHELORS_API_URL and
// MASTERS_API_URL, by default bachelors-api and masters-api.finki-hub.com)
// and rebuilds the thesis staff tables. Run by Data / Import theses (daily and by
// hand).
export default defineOperationApi({
  handler: (options, { database, env }) =>
    runThesisImport(options, sqlDatabase(database), {
      apis: {
        bachelors: setting(env['BACHELORS_API_URL'], defaultBachelorsApi),
        masters: setting(env['MASTERS_API_URL'], defaultMastersApi),
      },
      source: httpThesisSource(),
    }),
  id: thesisImportId,
});
