import { defineOperationApp } from '@directus/extensions-sdk';

// Studio definition of the thesis import operation; the API side is
// thesis-import.ts.
export default defineOperationApp({
  description:
    'Imports the theses from the theses APIs and rebuilds their staff tables. Answer: { bachelors, masters, committee, unmatched }.',
  icon: 'history_edu',
  id: 'finki-hub-thesis-import',
  name: 'FINKI Hub thesis import',
  options: [],
  overview: () => [],
});
