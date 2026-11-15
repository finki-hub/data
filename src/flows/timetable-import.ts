import {
  familyIds,
  familyStep,
  flowFamilyCodes,
  type FlowTemplate,
  raise,
} from './flow-template.js';
import { flowDescription, stepName } from './text-fragments.js';

const family = flowFamilyCodes.timetables;
const timetableImportOperation = 'finki-hub-timetable-import';

// The timetable import family: the button on the Data operations
// dashboard and the daily schedule, both running the import operation.
export const timetableId = familyIds(family);

const step = familyStep(family);

// Daily at 04:30 (the schedule's six-field cron, seconds first): after
// the timetables API's hourly archive refresh.
export const timetableImportCron = '0 30 4 * * *';

const summary = {
  changed: '{{ import.changed }}',
  fetched: '{{ import.fetched }}',
  lessons: '{{ import.lessons }}',
  main: '{{ import.main }}',
  teaching: '{{ import.teaching }}',
  timetables: '{{ import.timetables }}',
  unmatched: '{{ import.unmatched }}',
};

const answers = [
  'timetables',
  'main',
  'fetched',
  'changed',
  'lessons',
  'teaching',
  'unmatched',
];

const importNote =
  'Stores every listed timetable and the lessons of each main one that changed, then rebuilds course_teaching in the same transaction';

// The manual entry point on the data_operations singleton; a refusal
// answers the import's code and message.
export const timetableImportFlow: FlowTemplate = {
  accountability: 'activity',
  description: flowDescription({
    answers,
    does: 'Imports the timetables from timetables-api.finki-hub.com',
    input: ['all'],
    note: importNote,
  }),
  entry: timetableId('12'),
  icon: 'calendar_view_week',
  id: timetableId('01'),
  name: 'Data / Import timetables',
  operations: [
    step({
      edges: { reject: timetableId('22'), resolve: timetableId('13') },
      key: 'import',
      name: 'Import the timetables',
      options: { all: '{{ $trigger.body.all }}' },
      position: [19, 1],
      suffix: '12',
      type: timetableImportOperation,
    }),
    raise({
      error: {
        code: 'TIMETABLE_IMPORT_FAILED',
        message: 'Timetable import failed: {{ import.message }}',
        status: 502,
      },
      family,
      key: 'import_failed',
      name: stepName.raise('TIMETABLE_IMPORT_FAILED'),
      position: [19, 19],
      suffix: '22',
    }),
    step({
      key: 'summary',
      name: 'Answer the import summary',
      options: { json: summary },
      position: [37, 1],
      suffix: '13',
      type: 'transform',
    }),
  ],
  options: {
    async: false,
    collections: ['data_operations'],
    confirmationDescription: 'Import the timetables now?',
    error_on_reject: true,
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
    location: 'both',
    requireConfirmation: true,
    requireSelection: false,
  },
  trigger: 'manual',
};

// The daily import: the visible timetables and those never imported.
export const timetableScheduleFlow: FlowTemplate = {
  accountability: 'activity',
  description: flowDescription({
    answers,
    does: 'Imports the timetables from timetables-api.finki-hub.com every day at 04:30',
    note: importNote,
  }),
  entry: timetableId('31'),
  icon: 'schedule',
  id: timetableId('02'),
  name: 'Data / Import timetables daily',
  operations: [
    step({
      edges: { reject: timetableId('41'), resolve: timetableId('32') },
      key: 'import',
      name: 'Import the timetables',
      options: { all: false },
      position: [19, 1],
      suffix: '31',
      type: timetableImportOperation,
    }),
    step({
      key: 'import_failed',
      name: stepName.answerFailure('import'),
      options: {
        json: {
          code: '{{ import.code }}',
          message: '{{ import.message }}',
          ok: false,
          stage: 'import',
        },
      },
      position: [19, 19],
      suffix: '41',
      type: 'transform',
    }),
    step({
      key: 'summary',
      name: 'Answer the import summary',
      options: { json: summary },
      position: [37, 1],
      suffix: '32',
      type: 'transform',
    }),
  ],
  options: { cron: timetableImportCron },
  trigger: 'schedule',
};

export const timetableImportFlows: readonly FlowTemplate[] = [
  timetableImportFlow,
  timetableScheduleFlow,
];
