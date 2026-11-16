import { flowFamilyCodes, type FlowTemplate } from './flow-template.js';
import { importFlows } from './import-flows.js';

// The thesis import family: the button on the Data operations dashboard
// and the daily schedule, both running the import operation.

// Daily at 05:00 (the schedule's six-field cron, seconds first), after the
// timetable import.
export const thesisImportCron = '0 0 5 * * *';

const does =
  'Imports the theses from bachelors-api and masters-api.finki-hub.com';

export const [thesisImportFlow, thesisScheduleFlow] = importFlows({
  answers: ['bachelors', 'masters', 'committee', 'unmatched'],
  confirmation: 'Import the theses now?',
  cron: thesisImportCron,
  does,
  failure: {
    code: 'THESIS_IMPORT_FAILED',
    message: 'Thesis import failed: {{ import.message }}',
  },
  family: flowFamilyCodes.theses,
  fields: [],
  icon: 'history_edu',
  manualOptions: {},
  name: 'Data / Import theses',
  note: 'Replaces every thesis and rebuilds the thesis staff tables in the same transaction',
  operation: 'finki-hub-thesis-import',
  scheduleDoes: `${does} every day at 05:00`,
  scheduleOptions: {},
  stepLabel: 'Import the theses',
});

export const thesisImportFlows: readonly FlowTemplate[] = [
  thesisImportFlow,
  thesisScheduleFlow,
];
