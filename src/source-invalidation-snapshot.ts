import { writeFile } from 'node:fs/promises';

import { sourceInvalidationSql } from '../directus/extensions/directus-extension-data-operations/src/source-invalidation-sql.js';

// `npm run generate:invalidation`: rewrites the reviewed snapshot of the
// source-invalidation migration after the collection-role registry
// changed. The migration itself is generated when the bundle loads; the
// snapshot shows the change in review and runs with psql, and
// test/source-invalidation.test.ts fails while the two differ.
await writeFile(
  'directus/extensions/directus-extension-data-operations/src/source-invalidation.sql',
  sourceInvalidationSql,
);
