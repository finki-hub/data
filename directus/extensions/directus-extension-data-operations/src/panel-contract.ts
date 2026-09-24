import { z } from 'zod';

import {
  humanize,
  isManagedFlowName,
  operationsCollection,
} from './managed-flows.js';

// What the Run operation panel needs from a manual Flow, in plain
// functions it can test without Studio: whether the Flow can be run from a
// panel, its own confirmation text and dialog fields, the validated body
// of the native POST /flows/trigger/:id, and a bounded reading of the
// answer or the refusal. The dialog fields are the Flow's own; the API
// ignores them, so every Flow keeps validating its input itself.

// One confirmation field as a manual Flow stores it (options.fields).
const dialogField = z.looseObject({
  field: z.string().min(1),
  meta: z
    .looseObject({
      interface: z.string().nullish(),
      required: z.boolean().nullish(),
    })
    .nullish(),
  name: z.string().nullish(),
  type: z.string().min(1),
});

export type DialogField = z.infer<typeof dialogField> & { name: string };

// The options the engine and Studio read (contracts §2.2 Manual).
const manualOptions = z.looseObject({
  async: z.boolean().nullish(),
  collections: z.array(z.string()).nullish(),
  confirmationDescription: z.string().nullish(),
  error_on_reject: z.boolean().nullish(),
  fields: z.array(dialogField).nullish(),
  requireConfirmation: z.boolean().nullish(),
  requireSelection: z.boolean().nullish(),
});

export const manualFlowSchema = z.object({
  description: z.string().nullish(),
  icon: z.string().nullish(),
  id: z.string(),
  name: z.string(),
  options: manualOptions.nullish(),
  status: z.string(),
  trigger: z.string(),
});

export type ManualFlow = z.infer<typeof manualFlowSchema>;

// The fields of GET /flows/:id the panel reads (Studio's recommended read
// of manual Flows allows exactly these, plus description).
export const flowFields = [
  'id',
  'name',
  'description',
  'icon',
  'status',
  'trigger',
  'options',
] as const;

// The panel's Flow option, as Studio's item dropdown stores it
// ({ key, collection: 'directus_flows' }) or as a plain id.
const flowOption = z.union([
  z.object({
    collection: z.literal('directus_flows').optional(),
    key: z.string().min(1),
  }),
  z
    .string()
    .min(1)
    .transform((key) => ({ key })),
]);

export const flowKeyOf = (option: unknown): null | string => {
  const parsed = flowOption.safeParse(option);
  return parsed.success ? parsed.data.key : null;
};

export type RunPlan =
  | {
      readonly collection: string;
      readonly confirm: boolean;
      readonly description: string;
      readonly fields: readonly DialogField[];
      readonly runnable: true;
    }
  | { readonly reason: string; readonly runnable: false };

const refuse = (reason: string): RunPlan => ({ reason, runnable: false });

// Whether a panel can run the Flow, and how: an active manual Flow of a
// managed family on the Data Operations collection alone, without a
// required item selection, that reports its failures. Directus answers an
// asynchronous run with 204 before it runs, and a synchronous one without
// Error on Reject with 200 even when a step failed, so the panel would
// show either as finished.
export const runPlan = (flow: ManualFlow): RunPlan => {
  if (flow.trigger !== 'manual') {
    return refuse('This Flow has no manual trigger, so no panel runs it.');
  }
  if (!isManagedFlowName(flow.name)) {
    return refuse(
      'This Flow is not a data operation (its name starts with neither "Data / " nor "Publish / ").',
    );
  }
  if (flow.status !== 'active') {
    return refuse('This Flow is inactive; activate it in its settings.');
  }
  const options = flow.options ?? {};
  const collections = options.collections ?? [];
  if (collections.length === 0) {
    return refuse(
      'This Flow names no collection, so Directus refuses to run it.',
    );
  }
  if (collections.some((collection) => collection !== operationsCollection)) {
    return refuse(
      `A data operation runs on the collection ${operationsCollection} alone, which no editor reads; set it as the Flow's only collection.`,
    );
  }
  if (options.requireSelection !== false) {
    return refuse(
      'This Flow needs selected items; run it from its collection page.',
    );
  }
  if (options.async === true || options.error_on_reject !== true) {
    return refuse(
      'This Flow would not report a failure to the panel: in its trigger, turn Asynchronous off and Error on Reject on.',
    );
  }
  return {
    collection: operationsCollection,
    confirm: options.requireConfirmation === true,
    description:
      options.confirmationDescription ?? `Run the Flow "${flow.name}"?`,
    // Studio names a field without a name after its key.
    fields: (options.fields ?? []).map((field) => ({
      ...field,
      name: field.name ?? humanize(field.field),
    })),
    runnable: true,
  };
};

export type DialogValues = Readonly<Record<string, unknown>>;

const emptyValues: ReadonlySet<unknown> = new Set(['', null, undefined]);

const absent = (value: unknown): boolean => emptyValues.has(value);

// The required dialog fields still without a value (Studio keeps its Run
// button disabled for the same fields).
export const missingRequired = (
  fields: readonly DialogField[],
  values: DialogValues,
): string[] =>
  fields
    .filter(
      ({ field, meta }) => meta?.required === true && absent(values[field]),
    )
    .map(({ name }) => name);

// What the dialog of a retry opens with: the inputs of the failed run for
// every declared field but the boolean ones. A boolean acknowledges one
// run (a replacement, an empty snapshot), so it is given again for each
// run; a new run opens with nothing, as Studio's own dialog does.
export const retryValues = (
  fields: readonly DialogField[],
  failed: DialogValues,
): DialogValues =>
  Object.fromEntries(
    fields.flatMap(({ field, type }) =>
      type === 'boolean' || absent(failed[field])
        ? []
        : [[field, failed[field]]],
    ),
  );

export const triggerBodySchema = z
  .object({ collection: z.string().min(1) })
  .catchall(z.unknown());

// The body of POST /flows/trigger/:id: the Flow's collection and the
// values of its own dialog fields, nothing else.
export const triggerBody = (
  plan: Extract<RunPlan, { runnable: true }>,
  values: DialogValues,
): z.infer<typeof triggerBodySchema> =>
  triggerBodySchema.parse({
    ...Object.fromEntries(
      plan.fields.flatMap(({ field }) =>
        absent(values[field]) ? [] : [[field, values[field]]],
      ),
    ),
    collection: plan.collection,
  });
