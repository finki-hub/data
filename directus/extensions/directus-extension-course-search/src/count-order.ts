import type { Filter, Query } from '@directus/types';

import { z } from 'zod';

import { pageSize } from './limits.js';

export type ItemsReader = {
  readonly readByQuery: (query: Query) => Promise<readonly unknown[]>;
};

export type SearchSort = '-Courses Count' | 'Courses Count' | 'Name';

type PageRequest = {
  readonly deep?: Query['deep'];
  readonly fields: readonly string[];
  readonly page: number;
  readonly query: { readonly filter: Filter; readonly search?: string };
  readonly sort: SearchSort;
};

type Segment = { readonly limit: number; readonly offset: number };

const countRows = z.array(
  z.object({ count: z.object({ id: z.coerce.number().int().min(0) }) }),
);

export const countOf = (rows: unknown): number =>
  countRows.parse(rows)[0]?.count.id ?? 0;

// Where one page falls in the two segments of a count order: the users
// with a stored Courses Count, in the chosen direction, then those without
// one. The page takes what the counted segment still holds from its
// offset and fills the rest from the start of the uncounted one.
export const pageSegments = (
  page: number,
  counted: number,
): { readonly counted: Segment; readonly uncounted: Segment } => {
  const offset = (page - 1) * pageSize;
  const limit = Math.min(pageSize, Math.max(0, counted - offset));
  return {
    counted: { limit, offset },
    uncounted: {
      limit: pageSize - limit,
      offset: Math.max(0, offset - counted),
    },
  };
};

const narrowed = (
  query: PageRequest['query'],
  filter: Filter,
): PageRequest['query'] => ({
  ...query,
  filter: { _and: [query.filter, filter] },
});

// One page of matching users through the caller's own ItemsService.
// PostgreSQL sorts NULL first in a descending order, and ItemsService has
// no NULLS LAST, so a count order reads users whose Courses Count is
// stored first (in the chosen direction) and users without one after them
// in both directions, each segment tied by name and id.
export const readPage = async (
  items: ItemsReader,
  request: PageRequest,
): Promise<unknown[]> => {
  const fields = [...request.fields];
  const deep = request.deep === undefined ? {} : { deep: request.deep };
  if (request.sort === 'Name') {
    return [
      ...(await items.readByQuery({
        ...request.query,
        ...deep,
        fields,
        limit: pageSize,
        offset: (request.page - 1) * pageSize,
        sort: ['Name', 'id'],
      })),
    ];
  }
  const counted = narrowed(request.query, {
    'Courses Count': { _nnull: true },
  });
  const uncounted = narrowed(request.query, {
    'Courses Count': { _null: true },
  });
  const segments = pageSegments(
    request.page,
    countOf(
      await items.readByQuery({ ...counted, aggregate: { count: ['id'] } }),
    ),
  );
  const [head, tail] = await Promise.all([
    segments.counted.limit === 0
      ? []
      : items.readByQuery({
          ...counted,
          ...segments.counted,
          ...deep,
          fields,
          sort: [request.sort, 'Name', 'id'],
        }),
    segments.uncounted.limit === 0
      ? []
      : items.readByQuery({
          ...uncounted,
          ...segments.uncounted,
          ...deep,
          fields,
          sort: ['Name', 'id'],
        }),
  ]);
  return [...head, ...tail];
};

type AllRequest = Omit<PageRequest, 'page'>;

// Every row of one query, read on until a page comes back empty, because
// QUERY_LIMIT_MAX may cut a read of limit -1 short.
const readEvery = async (
  items: ItemsReader,
  query: Query,
): Promise<unknown[]> => {
  const rows: unknown[] = [];
  for (;;) {
    const page = await items.readByQuery({
      ...query,
      limit: -1,
      offset: rows.length,
    });
    if (page.length === 0) return rows;
    rows.push(...page);
  }
};

// Every matching user in the order of `readPage`: by name, or the users
// with a stored Courses Count in the chosen direction, then those without.
export const readAll = async (
  items: ItemsReader,
  request: AllRequest,
): Promise<unknown[]> => {
  const fields = [...request.fields];
  const deep = request.deep === undefined ? {} : { deep: request.deep };
  if (request.sort === 'Name') {
    return readEvery(items, {
      ...request.query,
      ...deep,
      fields,
      sort: ['Name', 'id'],
    });
  }
  const counted = await readEvery(items, {
    ...narrowed(request.query, { 'Courses Count': { _nnull: true } }),
    ...deep,
    fields,
    sort: [request.sort, 'Name', 'id'],
  });
  const uncounted = await readEvery(items, {
    ...narrowed(request.query, { 'Courses Count': { _null: true } }),
    ...deep,
    fields,
    sort: ['Name', 'id'],
  });
  return [...counted, ...uncounted];
};
