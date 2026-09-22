import { z } from 'zod';

import type { DirectusRequest } from '../directus-request.js';

export const defaultPageSize = 250;

type Row = { readonly id: number | string };

export type Listing<S extends z.ZodType<Row>> = {
  readonly fields: readonly string[];
  readonly pageSize?: number;
  readonly pathname: string;
  readonly schema: S;
};

export class PagingError extends Error {
  public override readonly name = 'PagingError';
}

const query = (
  listing: Listing<z.ZodType<Row>>,
  offset: number,
  pageSize: number,
): string =>
  [
    ['fields', listing.fields.join(',')],
    ['limit', String(pageSize)],
    ['offset', String(offset)],
    ['sort', 'id'],
  ]
    .map(([name, value]) => `${name ?? ''}=${encodeURIComponent(value ?? '')}`)
    .join('&');

// Reads every row of a listing endpoint with an explicit field list, sorted
// by id, page by page. The offset advances by the rows the server actually
// returned and the read stops only at an empty page, so a server that clamps
// `limit` below the requested page size (QUERY_LIMIT_MAX) still yields the
// whole collection instead of a silently truncated first page. A page that
// repeats an id already read means the server ignored the offset or the
// rows moved underneath the read; that is an error, never a shorter result.
// Never asks for `*`.
export const readAll = async <S extends z.ZodType<Row>>(
  request: DirectusRequest,
  listing: Listing<S>,
): Promise<ReadonlyArray<z.output<S>>> => {
  const pageSize = listing.pageSize ?? defaultPageSize;
  const rows: Array<z.output<S>> = [];
  const seen = new Set<number | string>();
  let offset = 0;
  for (;;) {
    const page = z
      .array(listing.schema)
      .parse(
        await request(
          `${listing.pathname}?${query(listing, offset, pageSize)}`,
        ),
      );
    const [first] = page;
    if (first === undefined) {
      return rows;
    }
    if (seen.has(first.id)) {
      throw new PagingError(
        `${listing.pathname} returned row ${String(first.id)} again at offset ${String(offset)}; the server ignored the offset or the rows changed while they were read. Run the inventory again.`,
      );
    }
    for (const row of page) {
      seen.add(row.id);
    }
    rows.push(...page);
    offset += page.length;
  }
};
