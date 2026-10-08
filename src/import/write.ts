import type { DirectusRequest } from '../directus-request.js';
import type { Scalar } from '../schema.js';

import { chunk, createRows } from './batches.js';
import {
  displayKey,
  isRef,
  type PlannedCollection,
  type PlannedRecord,
} from './planned.js';

// A planned row refers to a row the plan does not create before it, or two
// planned rows share a key: a bug in the plan, not a condition to retry.
class ImportPlanError extends Error {
  public override readonly name = 'ImportPlanError';
}

type CreatedIds = ReadonlyMap<string, ReadonlyMap<string, number>>;

// The record with every reference replaced by the id the row it names got
// (from Directus, or in the memory store of src/projection/).
export const resolved = (
  collection: string,
  record: PlannedRecord,
  created: CreatedIds,
): Readonly<Record<string, Scalar>> =>
  Object.fromEntries(
    Object.entries(record).map(([field, value]) => {
      if (!isRef(value)) {
        return [field, value];
      }
      const id = created.get(value.collection)?.get(value.key);
      if (id === undefined) {
        throw new ImportPlanError(
          `plan: ${collection}.${field} references ${value.collection} ${displayKey(value.key)} before it is created`,
        );
      }
      return [field, id];
    }),
  );

// Records the id a planned row got under its plan key; a key the
// collection already holds is a bug in the plan.
export const recordId = (
  ids: Map<string, number>,
  { collection, key }: { readonly collection: string; readonly key: string },
  id: number,
): void => {
  if (ids.has(key)) {
    throw new ImportPlanError(
      `plan: duplicate ${collection} key ${displayKey(key)}`,
    );
  }
  ids.set(key, id);
};

type WriteOptions = {
  readonly batchSize: number;
  // Hears the rows Directus confirmed, batch by batch.
  readonly confirmed: (rows: number) => void;
};

// Writes the planned collections in their order, in bounded batches,
// resolving each reference through the ids the create responses answered.
// Answers the rows written per collection.
export const writePlan = async (
  request: DirectusRequest,
  collections: readonly PlannedCollection[],
  { batchSize, confirmed }: WriteOptions,
): Promise<Readonly<Record<string, number>>> => {
  const created = new Map<string, ReadonlyMap<string, number>>();
  const written: Array<[string, number]> = [];
  for (const { collection, rows } of collections) {
    const ids = new Map<string, number>();
    for (const batch of chunk(rows, batchSize)) {
      const answered = await createRows(
        request,
        collection,
        batch.map(({ record }) => resolved(collection, record, created)),
      );
      confirmed(answered.length);
      for (const [index, row] of batch.entries()) {
        const id = answered[index];
        if (id === undefined) {
          throw new TypeError(
            `POST /items/${collection}: no id for row ${displayKey(row.key)}`,
          );
        }
        recordId(ids, { collection, key: row.key }, id);
      }
    }
    created.set(collection, ids);
    written.push([collection, rows.length]);
  }
  return Object.fromEntries(written);
};
