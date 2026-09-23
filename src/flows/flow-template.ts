// The shape of a Flow the setup installs once, with deterministic ids so a
// rerun recognises it, and the helpers every Flow family shares.
export const coordinateOperation = 'finki-hub-data-coordinate';

// The export operation of the data-operations extension: readiness and the
// preparation of every public file its export definitions declare.
export const exportsOperation = 'finki-hub-exports';

const idPrefix = '6a1d9f0e-2b3c-4d5e-8f70-00000000';

// The two hex digits of every managed Flow family, declared once: an id,
// an operation and a failure branch accept only these codes, and
// `flowFamilies` (registry.ts) installs exactly these families. A new
// family is one code here and one registry entry. The checkpoint family
// 07 (Rebuild derived data, Publish public assets) stays outside, until
// the deferred cleanup removes it.
export const flowFamilyCodes = {
  automation: '13',
  history: '09',
  legacy: '12',
  mapped: '11',
  publication: '14',
  snapshot: '10',
} as const;

export type FlowFamilyCode =
  (typeof flowFamilyCodes)[keyof typeof flowFamilyCodes];

const deterministicId = (family: string, suffix: string): string =>
  `${idPrefix}${family}${suffix}`;

// A deterministic UUID: two hex digits name the Flow family, the suffix one
// Flow or operation inside it.
export const familyId = (family: FlowFamilyCode, suffix: string): string =>
  deterministicId(family, suffix);

// The id maker of one family.
export const familyIds =
  (family: FlowFamilyCode) =>
  (suffix: string): string =>
    familyId(family, suffix);

// The history index family (Task 9).
export const historyId = familyIds(flowFamilyCodes.history);

// The Moodle snapshot import family (Task 10).
export const snapshotId = familyIds(flowFamilyCodes.snapshot);

// The automatic processing family (the enrollment dispatcher, Mark pending
// and the scheduled Process pending).
export const automationId = familyIds(flowFamilyCodes.automation);

// The publication family (Data / Validate readiness and Publish / Prepare
// public assets).
export const publicationId = familyIds(flowFamilyCodes.publication);

// A deterministic UUID of the checkpoint Flows the workbook import installs
// (Rebuild derived data, Publish public assets); not a managed family.
export const checkpointFlowId = (suffix: string): string =>
  deterministicId('07', suffix);

export type OperationTemplate = {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly position_x: number;
  readonly position_y: number;
  readonly reject: null | string;
  readonly resolve: null | string;
  readonly type: string;
};

export type FlowTemplate = {
  readonly accountability: 'activity';
  readonly description: string;
  readonly entry: string;
  readonly icon: string;
  readonly id: string;
  readonly name: string;
  readonly operations: readonly OperationTemplate[];
  readonly options: Readonly<Record<string, unknown>>;
  readonly trigger: 'manual' | 'operation' | 'schedule';
};

export type OperationEdges = {
  readonly reject?: string;
  readonly resolve?: string;
};

export type OperationSpec = {
  readonly edges?: OperationEdges;
  // The Flow family the operation belongs to; its id carries the code.
  readonly family: FlowFamilyCode;
  readonly key: string;
  readonly name: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly position: readonly [number, number];
  readonly suffix: string;
  readonly type: string;
};

export const operation = (spec: OperationSpec): OperationTemplate => ({
  id: familyId(spec.family, spec.suffix),
  key: spec.key,
  name: spec.name,
  options: spec.options,
  position_x: spec.position[0],
  position_y: spec.position[1],
  reject: spec.edges?.reject ?? null,
  resolve: spec.edges?.resolve ?? null,
  type: spec.type,
});

type StepSpec = Omit<OperationSpec, 'options' | 'type'>;

// The operation maker of one family, so a family's modules never repeat its
// code.
export const familyStep =
  (family: FlowFamilyCode) =>
  (spec: Omit<OperationSpec, 'family'>): OperationTemplate =>
    operation({ ...spec, family });

// A Condition operation: resolves when the data chain matches the filter.
export const condition = ({
  filter,
  ...spec
}: StepSpec & {
  readonly filter: Readonly<Record<string, unknown>>;
}): OperationTemplate =>
  operation({ ...spec, options: { filter }, type: 'condition' });

// A Throw Error operation, the end of a branch: the manual Flow answers
// the status, code and (templated) message instead of a result.
export const raise = ({
  error,
  ...spec
}: Omit<StepSpec, 'edges'> & {
  readonly error: {
    readonly code: string;
    readonly message: string;
    // A number, or an exact template that resolves to one.
    readonly status: number | string;
  };
}): OperationTemplate =>
  operation({ ...spec, options: error, type: 'throw-error' });

// A failure record in place of a result, built from the rejected
// operation's error (`$last` at that point) without carrying an Error
// object further down the chain.
export const failureRecord = (
  extra: Readonly<Record<string, string>>,
): Readonly<Record<string, unknown>> => ({
  json: {
    ...extra,
    code: '{{ $last.code }}',
    message: '{{ $last.message }}',
    ok: false,
  },
});

// Operations ordered so that every resolve/reject target is created first:
// the edge foreign keys are checked at once.
export const insertionOrder = (
  operations: readonly OperationTemplate[],
): OperationTemplate[] => {
  const remaining = new Map(operations.map((entry) => [entry.id, entry]));
  const order: OperationTemplate[] = [];
  while (remaining.size > 0) {
    const free = remaining
      .values()
      .filter(
        ({ reject, resolve }) =>
          (resolve === null || !remaining.has(resolve)) &&
          (reject === null || !remaining.has(reject)),
      )
      .toArray();
    if (free.length === 0) {
      throw new Error('The Flow operations form a cycle');
    }
    for (const entry of free) {
      order.push(entry);
      remaining.delete(entry.id);
    }
  }
  return order;
};
