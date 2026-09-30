import { z } from 'zod';

import type { DirectusRequest } from '../directus-request.js';

// Rows per POST, the import's bound.
export const defaultBatchSize = 250;

// Batches of at most `size` items, in order.
export const chunk = <T>(
  items: readonly T[],
  size: number,
): ReadonlyArray<readonly T[]> => {
  const chunks: Array<readonly T[]> = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
};

const createdRows = z.array(z.object({ id: z.number().int() }));

// One POST of many rows: Directus creates them in one transaction, in the
// order given, so their ids ascend in that order. Answers the ids, in the
// order of the records; Directus must confirm every row.
export const createRows = async (
  request: DirectusRequest,
  collection: string,
  records: ReadonlyArray<Readonly<Record<string, unknown>>>,
): Promise<readonly number[]> => {
  const created = createdRows.parse(
    await request(`/items/${collection}?fields=id`, {
      body: JSON.stringify(records),
      method: 'POST',
    }),
  );
  if (created.length !== records.length) {
    throw new Error(
      `POST /items/${collection}: ids ${String(created.length)}, expected ${String(records.length)}`,
    );
  }
  return created.map(({ id }) => id).toSorted((left, right) => left - right);
};
