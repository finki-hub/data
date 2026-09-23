// The shape of a Flow the setup installs once, with deterministic ids so a
// rerun recognises it, and the helpers the history index templates share.
export const coordinateOperation = 'finki-hub-data-coordinate';

// The export operation of the data-operations extension: readiness and the
// preparation of every public file its export definitions declare.
export const exportsOperation = 'finki-hub-exports';

const idPrefix = '6a1d9f0e-2b3c-4d5e-8f70-00000000';

// A deterministic UUID: two hex digits name the Flow family, the suffix one
// Flow or operation inside it.
export const familyId = (family: string, suffix: string): string =>
  `${idPrefix}${family}${suffix}`;

// A deterministic UUID of the history index Flow family.
export const historyId = (suffix: string): string => familyId('09', suffix);

// A deterministic UUID of the Moodle snapshot import Flow family.
export const snapshotId = (suffix: string): string => familyId('10', suffix);

// A deterministic UUID of the checkpoint Flows the workbook import installs
// (Rebuild derived data, Publish public assets).
export const checkpointFlowId = (suffix: string): string =>
  familyId('07', suffix);

// A deterministic UUID of the automatic processing Flow family (the
// enrollment dispatcher, Mark pending and the scheduled Process pending).
export const automationId = (suffix: string): string => familyId('13', suffix);

// A deterministic UUID of the publication Flow family (Data / Validate
// readiness and Publish / Prepare public assets).
export const publicationId = (suffix: string): string => familyId('14', suffix);

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
  // The two hex digits of the Flow family; the history index family 09
  // when absent.
  readonly family?: string;
  readonly key: string;
  readonly name: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly position: readonly [number, number];
  readonly suffix: string;
  readonly type: string;
};

export const operation = (spec: OperationSpec): OperationTemplate => ({
  id: familyId(spec.family ?? '09', spec.suffix),
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
