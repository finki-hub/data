import {
  familyIds,
  familyStep,
  type FlowFamilyCode,
  type FlowTemplate,
  raise,
} from './flow-template.js';
import { flowDescription, stepName } from './text-fragments.js';

// An import family: a button on the Data operations dashboard and a daily
// schedule, both running one import operation and answering its summary.
export type ImportFlowSpec = {
  readonly answers: readonly string[];
  readonly confirmation: string;
  readonly cron: string;
  // What the button does, and the same at the schedule's time.
  readonly does: string;
  readonly failure: { readonly code: string; readonly message: string };
  readonly family: FlowFamilyCode;
  readonly fields: readonly unknown[];
  readonly icon: string;
  readonly input?: readonly string[];
  readonly manualOptions: Record<string, unknown>;
  readonly name: string;
  readonly note: string;
  readonly operation: string;
  readonly scheduleDoes: string;
  readonly scheduleOptions: Record<string, unknown>;
  readonly stepLabel: string;
};

const byName = new Intl.Collator('en').compare;

// The summary transform: every answer of the import step, by name.
const summaryOf = (answers: readonly string[]): Record<string, string> =>
  Object.fromEntries(
    answers
      .toSorted(byName)
      .map((answer) => [answer, `{{ import.${answer} }}`]),
  );

export const importFlows = (
  spec: ImportFlowSpec,
): readonly [FlowTemplate, FlowTemplate] => {
  const id = familyIds(spec.family);
  const step = familyStep(spec.family);
  const summary = summaryOf(spec.answers);
  const answers = [...spec.answers];
  const summaryStep = (suffix: string) =>
    step({
      key: 'summary',
      name: 'Answer the import summary',
      options: { json: summary },
      position: [37, 1],
      suffix,
      type: 'transform',
    });
  // The manual entry point on the data_operations singleton; a refusal
  // answers the import's code and message.
  const manual: FlowTemplate = {
    accountability: 'activity',
    description: flowDescription({
      answers,
      does: spec.does,
      ...(spec.input !== undefined && { input: [...spec.input] }),
      note: spec.note,
    }),
    entry: id('12'),
    icon: spec.icon,
    id: id('01'),
    name: spec.name,
    operations: [
      step({
        edges: { reject: id('22'), resolve: id('13') },
        key: 'import',
        name: spec.stepLabel,
        options: spec.manualOptions,
        position: [19, 1],
        suffix: '12',
        type: spec.operation,
      }),
      raise({
        error: { ...spec.failure, status: 502 },
        family: spec.family,
        key: 'import_failed',
        name: stepName.raise(spec.failure.code),
        position: [19, 19],
        suffix: '22',
      }),
      summaryStep('13'),
    ],
    options: {
      async: false,
      collections: ['data_operations'],
      confirmationDescription: spec.confirmation,
      error_on_reject: true,
      fields: [...spec.fields],
      location: 'both',
      requireConfirmation: true,
      requireSelection: false,
    },
    trigger: 'manual',
  };
  const schedule: FlowTemplate = {
    accountability: 'activity',
    description: flowDescription({
      answers,
      does: spec.scheduleDoes,
      note: spec.note,
    }),
    entry: id('31'),
    icon: 'schedule',
    id: id('02'),
    name: `${spec.name} daily`,
    operations: [
      step({
        edges: { reject: id('41'), resolve: id('32') },
        key: 'import',
        name: spec.stepLabel,
        options: spec.scheduleOptions,
        position: [19, 1],
        suffix: '31',
        type: spec.operation,
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
      summaryStep('32'),
    ],
    options: { cron: spec.cron },
    trigger: 'schedule',
  };
  return [manual, schedule];
};
