import { defineOperationApp } from '@directus/extensions-sdk';

// Studio definition of the thesis import operation; the API side is
// thesis-import.ts.
export default defineOperationApp({
  description:
    'Imports the theses from the theses APIs and rebuilds their staff tables. Answer: { bachelors, masters, committee, unmatched }.',
  icon: 'history_edu',
  id: 'finki-hub-thesis-import',
  name: 'FINKI Hub thesis import',
  options: [
    {
      field: 'shrink',
      meta: {
        interface: 'input',
        note: 'true accepts a list shorter than the stored theses, for example {{ $trigger.body.shrink }}.',
        width: 'full',
      },
      name: 'Accept fewer theses',
      type: 'string',
    },
  ],
  overview: (options: Record<string, unknown>) => [
    {
      label: 'Accept fewer theses',
      text: typeof options['shrink'] === 'string' ? options['shrink'] : '--',
    },
  ],
});
