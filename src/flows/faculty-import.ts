import { flowFamilyCodes, type FlowTemplate } from './flow-template.js';
import { importFlows } from './import-flows.js';

// The faculty structure import family: the button on the Data operations
// dashboard and the daily schedule, both running the import operation.

// Daily at 05:30 (the schedule's six-field cron, seconds first), after the
// thesis import.
export const facultyImportCron = '0 30 5 * * *';

const does =
  'Imports the faculty structure and staff profiles from finki.ukim.mk';

export const [facultyImportFlow, facultyScheduleFlow] = importFlows({
  answers: [
    'bios',
    'centers',
    'council',
    'institutes',
    'issues',
    'members',
    'photos',
    'unmatched',
  ],
  confirmation: 'Import the faculty structure now?',
  cron: facultyImportCron,
  does,
  failure: {
    code: 'FACULTY_IMPORT_FAILED',
    message: 'Faculty structure import failed: {{ import.message }}',
  },
  family: flowFamilyCodes.faculty,
  fields: [],
  icon: 'account_tree',
  manualOptions: {},
  name: 'Data / Import faculty structure',
  note: 'Replaces the institutes, their members, the centers and the import issues, and sets the photo, biography and council flag of staff',
  operation: 'finki-hub-faculty-import',
  scheduleDoes: `${does} every day at 05:30`,
  scheduleOptions: {},
  stepLabel: 'Import the faculty structure',
});

export const facultyImportFlows: readonly FlowTemplate[] = [
  facultyImportFlow,
  facultyScheduleFlow,
];
