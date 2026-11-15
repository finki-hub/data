import { defineOperationApp } from '@directus/extensions-sdk';

// Studio definition of the timetable import operation; the API side is
// timetable-import.ts.
export default defineOperationApp({
  description:
    'Imports the timetables from the timetables API and rebuilds course_teaching. Answer: { timetables, main, fetched, changed, empty, lessons, teaching, unmatched }.',
  icon: 'calendar_view_week',
  id: 'finki-hub-timetable-import',
  name: 'FINKI Hub timetable import',
  options: [
    {
      field: 'all',
      meta: {
        interface: 'input',
        note: 'true fetches every main timetable again, for example {{ $trigger.body.all }}.',
        width: 'full',
      },
      name: 'Fetch every timetable',
      type: 'string',
    },
  ],
  overview: (options: Record<string, unknown>) => [
    {
      label: 'Fetch every timetable',
      text: typeof options['all'] === 'string' ? options['all'] : '--',
    },
  ],
});
