import type { StepContext } from './ledger-types.js';
import type { SourceMapEntry } from './source-map.js';

import { chunk, createRows, updateRows } from './batches.js';
import {
  type Conversion,
  ConverterError,
  type ConverterOptions,
  type PlannedWrite,
  type TargetRecord,
} from './converter-types.js';
import { createdKey } from './target-reads.js';

export type Applied = {
  // Every mapping of the conversion: the settled ones as they were, the
  // written ones now `existing` with their target ids.
  readonly mappings: readonly SourceMapEntry[];
};

const settle = (
  mappings: readonly SourceMapEntry[],
  targetId: number,
): readonly SourceMapEntry[] =>
  mappings.map((mapping) => ({ ...mapping, status: 'existing', targetId }));

const account = (
  options: ConverterOptions,
  collection: string,
  count: number,
): void => {
  options.sink.written[collection] =
    (options.sink.written[collection] ?? 0) + count;
};

export type CreatePlan<R extends TargetRecord> = {
  readonly collection: string;
  readonly conversion: Conversion<R>;
  // Rows sharing a group key are written in one batch (one transaction),
  // whole or not at all, so their presence can stand for the whole group.
  readonly group?: (record: R) => string;
  // The columns that identify a created row, read back after each POST.
  readonly key: readonly string[];
};

const createBatch = async <R extends TargetRecord>(
  context: StepContext,
  plan: CreatePlan<R>,
  writes: ReadonlyArray<PlannedWrite<R>>,
): Promise<readonly SourceMapEntry[]> => {
  const created = await createRows(context.request, {
    collection: plan.collection,
    fields: plan.key,
    records: writes.map(({ record }) => record),
  });
  const ids = new Map(
    created.map((row) => [createdKey(row, plan.key), row.id]),
  );
  return writes.flatMap((write) => {
    const id = ids.get(createdKey(write.record, plan.key));
    if (id === undefined) {
      throw new ConverterError(
        `Directus did not return the ${plan.collection} row created for ${JSON.stringify(plan.key.map((column) => write.record[column]))}.`,
      );
    }
    return settle(write.mappings, id);
  });
};

// Creates the pending rows of a conversion in bounded batches, recording
// the id map after every batch so an interruption keeps what was written
// and the resumed step, reading the target provenance fresh, creates only
// what is still missing.
export const applyCreates = async <R extends TargetRecord>(
  context: StepContext,
  options: ConverterOptions,
  plan: CreatePlan<R>,
): Promise<Applied> => {
  options.sink.findings.push(...plan.conversion.findings);
  const mappings: SourceMapEntry[] = [...plan.conversion.settled];
  const { group } = plan;
  const batches = chunk(
    plan.conversion.writes,
    options.batchSize,
    group === undefined ? undefined : ({ record }) => group(record),
  );
  for (const writes of batches) {
    const batch = await createBatch(context, plan, writes);
    mappings.push(...batch);
    await context.record(batch);
    account(options, plan.collection, writes.length);
  }
  return { mappings };
};

export type UpdatePlan<R extends TargetRecord & { readonly id: number }> = {
  readonly collection: string;
  readonly conversion: Conversion<R>;
};

// Sets link columns on existing rows in bounded batches; setting a link
// twice is idempotent, and the converter already skipped links present.
export const applyUpdates = async <
  R extends TargetRecord & { readonly id: number },
>(
  context: StepContext,
  options: ConverterOptions,
  plan: UpdatePlan<R>,
): Promise<Applied> => {
  options.sink.findings.push(...plan.conversion.findings);
  const mappings: SourceMapEntry[] = [...plan.conversion.settled];
  for (const writes of chunk(plan.conversion.writes, options.batchSize)) {
    await updateRows(context.request, {
      collection: plan.collection,
      records: writes.map(({ record }) => record),
    });
    const batch = writes.flatMap(({ mappings: entries }) =>
      entries.map((mapping) => ({ ...mapping, status: 'existing' as const })),
    );
    mappings.push(...batch);
    await context.record(batch);
    account(options, plan.collection, writes.length);
  }
  return { mappings };
};
