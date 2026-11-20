import { defineOperationApp } from '@directus/extensions-sdk';

// Studio definition of the faculty structure import operation; the API side
// is faculty-import.ts.
export default defineOperationApp({
  description:
    'Imports the faculty structure and staff profiles from finki.ukim.mk. Answer: { bios, centers, council, institutes, issues, members, photos, unmatched }.',
  icon: 'account_tree',
  id: 'finki-hub-faculty-import',
  name: 'FINKI Hub faculty structure import',
  options: [],
  overview: () => [],
});
