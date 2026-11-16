import { flowFamilyCodes, type FlowTemplate } from './flow-template.js';
import { importFlows } from './import-flows.js';

// The timetable import family: the button on the Data operations
// dashboard and the daily schedule, both running the import operation.

// Daily at 04:30 (the schedule's six-field cron, seconds first): after
// the timetables API's hourly archive refresh.
export const timetableImportCron = '0 30 4 * * *';

const does = 'Imports the timetables from timetables-api.finki-hub.com';

// The daily import fetches the visible timetables and those never
// imported.
export const [timetableImportFlow, timetableScheduleFlow] = importFlows({
  answers: [
    'timetables',
    'main',
    'fetched',
    'changed',
    'empty',
    'lessons',
    'teaching',
    'unmatched',
  ],
  confirmation: 'Import the timetables now?',
  cron: timetableImportCron,
  does,
  failure: {
    code: 'TIMETABLE_IMPORT_FAILED',
    message: 'Timetable import failed: {{ import.message }}',
  },
  family: flowFamilyCodes.timetables,
  fields: [
    {
      field: 'all',
      meta: {
        interface: 'boolean',
        note: 'Off: only the visible timetables and those never imported.',
        width: 'full',
      },
      name: 'Fetch every main timetable again',
      type: 'boolean',
    },
  ],
  icon: 'calendar_view_week',
  input: ['all'],
  manualOptions: { all: '{{ $trigger.body.all }}' },
  name: 'Data / Import timetables',
  note: 'Stores every listed timetable and the lessons of each main one that changed, then rebuilds course_teaching in the same transaction',
  operation: 'finki-hub-timetable-import',
  scheduleDoes: `${does} every day at 04:30`,
  scheduleOptions: { all: false },
  stepLabel: 'Import the timetables',
});

export const timetableImportFlows: readonly FlowTemplate[] = [
  timetableImportFlow,
  timetableScheduleFlow,
];
