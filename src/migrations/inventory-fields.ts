import { z } from 'zod';

import {
  type DirectusRequest,
  DirectusRequestError,
} from '../directus-request.js';
import { collectionKeys } from '../schema.js';

// `GET /fields/:collection` lists every field with its column schema; alias
// fields (relations shown on the other side, groups) carry no column.
const fieldRow = z.object({
  field: z.string(),
  schema: z.looseObject({}).nullable(),
});

export const columnsSchema = z.record(
  z.enum(collectionKeys),
  z.array(z.string()).readonly(),
);

export type Columns = z.infer<typeof columnsSchema>;

const collator = new Intl.Collator('en');

// The column-backed fields of a collection, sorted by name.
export const readColumns = async (
  request: DirectusRequest,
  collection: string,
): Promise<readonly string[]> =>
  z
    .array(fieldRow)
    .parse(await request(`/fields/${collection}`))
    .filter(({ schema }) => schema !== null)
    .map(({ field }) => field)
    .toSorted((left, right) => collator.compare(left, right));

// Null when the collection is not readable: Directus answers the fields
// listing of an unknown collection with FORBIDDEN, the same code it gives a
// missing permission, and in both cases nothing can be read from it.
export const readColumnsOrNull = async (
  request: DirectusRequest,
  collection: string,
): Promise<null | readonly string[]> => {
  try {
    return await readColumns(request, collection);
  } catch (error) {
    if (error instanceof DirectusRequestError && error.code === 'FORBIDDEN') {
      return null;
    }
    throw error;
  }
};

// The columns of every checkpoint collection, read in a fixed order.
export const readCheckpointColumns = async (
  request: DirectusRequest,
): Promise<Columns> => {
  const entries: Array<[string, readonly string[]]> = [];
  for (const collection of collectionKeys) {
    entries.push([collection, await readColumns(request, collection)]);
  }
  return columnsSchema.parse(Object.fromEntries(entries));
};
