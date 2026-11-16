import {
  familyIds,
  familyStep,
  flowFamilyCodes,
  type FlowTemplate,
  raise,
} from './flow-template.js';
import { flowDescription, stepName } from './text-fragments.js';

const family = flowFamilyCodes.theses;
const thesisImportOperation = 'finki-hub-thesis-import';

// The thesis import family: the button on the Data operations dashboard
// and the daily schedule, both running the import operation.
export const thesisId = familyIds(family);

const step = familyStep(family);

// Daily at 05:00 (the schedule's six-field cron, seconds first), after the
// timetable import.
export const thesisImportCron = '0 0 5 * * *';

const summary = {
  bachelors: '{{ import.bachelors }}',
  committee: '{{ import.committee }}',
  masters: '{{ import.masters }}',
  unmatched: '{{ import.unmatched }}',
};

const answers = ['bachelors', 'masters', 'committee', 'unmatched'];

const importNote =
  'Replaces every thesis and rebuilds thesis_committee in the same transaction';

const does =
  'Imports the theses from bachelors-api and masters-api.finki-hub.com';

// The manual entry point on the data_operations singleton; a refusal
// answers the import's code and message.
export const thesisImportFlow: FlowTemplate = {
  accountability: 'activity',
  description: flowDescription({ answers, does, note: importNote }),
  entry: thesisId('12'),
  icon: 'history_edu',
  id: thesisId('01'),
  name: 'Data / Import theses',
  operations: [
    step({
      edges: { reject: thesisId('22'), resolve: thesisId('13') },
      key: 'import',
      name: 'Import the theses',
      options: {},
      position: [19, 1],
      suffix: '12',
      type: thesisImportOperation,
    }),
    raise({
      error: {
        code: 'THESIS_IMPORT_FAILED',
        message: 'Thesis import failed: {{ import.message }}',
        status: 502,
      },
      family,
      key: 'import_failed',
      name: stepName.raise('THESIS_IMPORT_FAILED'),
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
    confirmationDescription: 'Import the theses now?',
    error_on_reject: true,
    fields: [],
    location: 'both',
    requireConfirmation: true,
    requireSelection: false,
  },
  trigger: 'manual',
};

export const thesisScheduleFlow: FlowTemplate = {
  accountability: 'activity',
  description: flowDescription({
    answers,
    does: `${does} every day at 05:00`,
    note: importNote,
  }),
  entry: thesisId('31'),
  icon: 'schedule',
  id: thesisId('02'),
  name: 'Data / Import theses daily',
  operations: [
    step({
      edges: { reject: thesisId('41'), resolve: thesisId('32') },
      key: 'import',
      name: 'Import the theses',
      options: {},
      position: [19, 1],
      suffix: '31',
      type: thesisImportOperation,
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
  options: { cron: thesisImportCron },
  trigger: 'schedule',
};

export const thesisImportFlows: readonly FlowTemplate[] = [
  thesisImportFlow,
  thesisScheduleFlow,
];
