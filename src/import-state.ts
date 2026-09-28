import { z } from 'zod';

import type { DirectusRequest } from './directus-request.js';

import { dataModelCollectionKeys } from './data-model/collections.js';

// The coordination singleton setup creates and every source transaction
// updates: operational bookkeeping, not source data, so a
// setup-created project still counts as empty with it present.
const bookkeeping: ReadonlySet<string> = new Set(['data_operations']);

// Every collection whose records make a project populated: the content
// collections, the relational ones, the Moodle staging and index
// collections and the candidate results.
export const applicationCollections: readonly string[] =
  dataModelCollectionKeys.filter((collection) => !bookkeeping.has(collection));

const collectionsSchema = z.array(
  z.object({ collection: z.string(), schema: z.unknown() }),
);

// `aggregate[count]` answers one row; PostgreSQL counts arrive as strings.
const countSchema = z
  .array(
    z.object({
      count: z.union([
        z.number().int().nonnegative(),
        z.string().regex(/^\d+$/u).transform(Number),
      ]),
    }),
  )
  .length(1);

type RecordCounts = Readonly<Record<string, number>>;

// The record count of every existing collection of that list holding at
// least one record; empty when the project has none (no collection yet, or
// the empty schema `npm run setup` creates). Reads only.
export const countApplicationRecords = async (
  request: DirectusRequest,
): Promise<RecordCounts> => {
  const tables = new Set(
    collectionsSchema
      .parse(await request('/collections'))
      .filter(({ schema }) => schema !== null && schema !== undefined)
      .map(({ collection }) => collection),
  );
  const counts: Array<[string, number]> = [];
  for (const collection of applicationCollections) {
    if (!tables.has(collection)) {
      continue;
    }
    const [row] = countSchema.parse(
      await request(`/items/${collection}?aggregate[count]=*`),
    );
    if (row !== undefined && row.count > 0) {
      counts.push([collection, row.count]);
    }
  }
  return Object.fromEntries(counts);
};

// The workbook import refused a populated project before its first write.
export class ExistingDataError extends Error {
  public override readonly name = 'ExistingDataError';

  public constructor(public readonly counts: RecordCounts) {
    const entries = Object.entries(counts);
    const listed = entries
      .map(([collection, count]) => `${collection} ${String(count)}`)
      .join(', ');
    const total = entries.reduce((sum, [, count]) => sum + count, 0);
    super(
      `The project already holds ${String(total)} record(s) in ${String(entries.length)} application collection(s): ${listed}. The one-time workbook import only fills a project whose application collections are empty (the empty schema npm run setup creates is fine); nothing was written.`,
    );
  }
}
