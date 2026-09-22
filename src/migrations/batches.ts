import { z } from 'zod';

import {
  type DirectusRequest,
  DirectusRequestError,
} from '../directus-request.js';

// Rows per POST or PATCH, the bound the checkpoint importer already uses.
export const defaultBatchSize = 250;

// A rejection the database raised against a converter's write: a duplicate
// domain key, a broken reference or a validation failure. The converter
// planned a row the model forbids, so the step fails and the ledger records
// why; the operator inspects the plan instead of the run retrying the same
// write.
export class ConverterWriteError extends Error {
  public override readonly name = 'ConverterWriteError';
}

const constraintCodes: ReadonlySet<string> = new Set([
  'FAILED_VALIDATION',
  'INVALID_FOREIGN_KEY',
  'RECORD_NOT_UNIQUE',
]);

// Batches of at most `size` items. With `group`, consecutive items sharing a
// group key never straddle two batches (a batch closes early instead, and a
// group larger than `size` forms a batch of its own), so a POST that is one
// transaction writes such a group whole or not at all.
export const chunk = <T>(
  items: readonly T[],
  size: number,
  group?: (item: T) => string,
): ReadonlyArray<readonly T[]> => {
  const chunks: Array<readonly T[]> = [];
  let batch: T[] = [];
  let run: T[] = [];
  let runKey: string | undefined;
  const flushRun = (): void => {
    if (batch.length > 0 && batch.length + run.length > size) {
      chunks.push(batch);
      batch = [];
    }
    batch.push(...run);
    run = [];
  };
  for (const item of items) {
    const key = group?.(item);
    if (run.length > 0 && (key === undefined || key !== runKey)) {
      flushRun();
    }
    runKey = key;
    run.push(item);
  }
  flushRun();
  if (batch.length > 0) {
    chunks.push(batch);
  }
  return chunks;
};

const json = (body: unknown, method: 'PATCH' | 'POST') => ({
  body: JSON.stringify(body),
  method,
});

const guarded = async <T>(
  collection: string,
  write: () => Promise<T>,
): Promise<T> => {
  try {
    return await write();
  } catch (error) {
    if (
      error instanceof DirectusRequestError &&
      error.code !== null &&
      constraintCodes.has(error.code)
    ) {
      throw new ConverterWriteError(
        `Converter bug: Directus rejected a write to ${collection} with ${error.code} (${error.reason ?? 'no reason'}). The planned rows violate the model; inspect the ledger and the plan before running again, never retry blindly.`,
        { cause: error },
      );
    }
    throw error;
  }
};

const createdRows = z.array(z.looseObject({ id: z.number().int() }));

export type CreatedRow = z.infer<typeof createdRows>[number];

export type CreateBatch = {
  readonly collection: string;
  // The columns to read back beside `id`, so each created row is matched
  // to its plan by its own key instead of by position.
  readonly fields: readonly string[];
  readonly records: ReadonlyArray<Readonly<Record<string, unknown>>>;
};

// One POST of many rows; Directus creates them in one transaction and
// returns the requested fields of every created row.
export const createRows = async (
  request: DirectusRequest,
  { collection, fields, records }: CreateBatch,
): Promise<readonly CreatedRow[]> => {
  if (records.length === 0) {
    return [];
  }
  const query = ['id', ...fields].join(',');
  return guarded(collection, async () =>
    createdRows.parse(
      await request(
        `/items/${collection}?fields=${query}`,
        json(records, 'POST'),
      ),
    ),
  );
};

export type UpdateBatch = {
  readonly collection: string;
  readonly records: ReadonlyArray<
    Readonly<Record<string, unknown>> & { readonly id: number }
  >;
};

// One PATCH of many rows by primary key (Directus `updateBatch`).
export const updateRows = async (
  request: DirectusRequest,
  { collection, records }: UpdateBatch,
): Promise<void> => {
  if (records.length === 0) {
    return;
  }
  await guarded(collection, () =>
    request(`/items/${collection}?fields=id`, json(records, 'PATCH')),
  );
};
