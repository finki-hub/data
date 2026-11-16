import { z } from 'zod';

import type { SqlClient, SqlDatabase } from '../coordination/sql-port.js';

import { affected, json, openGuard, run } from '../coordination/sql-run.js';
import {
  bachelorRows,
  bachelorsSchema,
  masterRows,
  mastersSchema,
} from './parse.js';
import {
  clearCommitteeSql,
  clearThesesSql,
  insertCommitteeSql,
  insertThesesSql,
  storedCountSql,
  thesisLockSql,
  unmatchedNamesSql,
} from './sql.js';
import {
  bachelorTable,
  masterTable,
  type ThesisTable,
  thesisTables,
} from './vocabulary.js';

// The thesis import: reads every bachelor's and master's thesis from the
// theses APIs of theses-listing, replaces the stored theses with them and
// rebuilds their staff tables, all in one transaction. The faculty never
// deletes a thesis, so a list shorter than the stored one is a broken
// source and refused, unless the run accepts it (`shrink`).

// A flag the Flow passes as a template: an absent one renders as ''.
export const thesisImportOptionsSchema = z.object({
  shrink: z
    .union([z.boolean(), z.literal(['true', 'false', '']), z.null()])
    .optional()
    .transform((value) => value === true || value === 'true'),
});

export const defaultBachelorsApi = 'https://bachelors-api.finki-hub.com';
export const defaultMastersApi = 'https://masters-api.finki-hub.com';

export const bachelorsPath = '/diplomas';
export const mastersPath = '/masters';

export type ThesisApis = {
  readonly bachelors: string;
  readonly masters: string;
};

// Where the import reads the theses: the two APIs over a source.
export type ThesisFeed = {
  readonly apis: ThesisApis;
  readonly source: ThesisSource;
};

export type ThesisImportSummary = {
  readonly bachelors: number;
  readonly committee: number;
  readonly masters: number;
  readonly unmatched: readonly UnmatchedName[];
};

// GET of a URL as JSON.
export type ThesisSource = (url: string) => Promise<unknown>;

export type UnmatchedName = { readonly name: string; readonly theses: number };

const unmatchedRows = z.array(
  z.object({ name: z.string(), theses: z.coerce.number().int() }),
);
const countRow = z.object({ count: z.coerce.number().int() });

// A refusal of the import, with a code the Flow answers.
export class ThesisImportError extends Error {
  public readonly code: string;
  public override readonly name = 'ThesisImportError';

  public constructor(
    message: string,
    options: ErrorOptions & { readonly code: string },
  ) {
    super(message, options);
    this.code = options.code;
  }
}

// Rebuilds both staff tables from the stored theses, the staff and
// staff_aliases, and answers how many rows they hold. The caller's
// transaction must not have opened another writer's guard.
export const rebuildCommittee = async (client: SqlClient): Promise<number> => {
  await run(client, thesisLockSql);
  await openGuard(client, 'bachelor_thesis_staff');
  let committee = 0;
  for (const thesis of thesisTables) {
    await run(client, clearCommitteeSql(thesis));
    committee += await affected(client, insertCommitteeSql(thesis));
  }
  return committee;
};

// Refuses a list shorter than the theses stored for it.
const refuseShrinking = async (
  client: SqlClient,
  thesis: ThesisTable,
  listed: number,
): Promise<void> => {
  const { rows } = await run(client, storedCountSql(thesis));
  const stored = countRow.parse(rows[0]).count;
  if (listed < stored) {
    throw new ThesisImportError(
      `${thesis.table}: ${String(listed)} listed, ${String(stored)} stored`,
      { code: 'THESES_SHRANK' },
    );
  }
};

const root = (base: string): string =>
  base.endsWith('/') ? base.slice(0, -1) : base;

const read = async <T>(
  source: ThesisSource,
  url: string,
  schema: z.ZodType<T>,
): Promise<T> => {
  const parsed = schema.safeParse(await source(url));
  if (!parsed.success) {
    throw new ThesisImportError(`${url}: unexpected response`, {
      code: 'THESES_INVALID',
    });
  }
  return parsed.data;
};

export const runThesisImport = async (
  options: unknown,
  database: SqlDatabase,
  { apis, source }: ThesisFeed,
): Promise<ThesisImportSummary> => {
  const { shrink } = thesisImportOptionsSchema.parse(options ?? {});
  const bachelorsUrl = `${root(apis.bachelors)}${bachelorsPath}`;
  const mastersUrl = `${root(apis.masters)}${mastersPath}`;
  const [bachelors, masters] = await Promise.all([
    read(source, bachelorsUrl, bachelorsSchema),
    read(source, mastersUrl, mastersSchema),
  ]);
  // An empty list is a broken source, never every thesis gone.
  if (bachelors.length === 0 || masters.length === 0) {
    throw new ThesisImportError('Theses APIs: an empty list', {
      code: 'THESES_INVALID',
    });
  }
  const rows = [
    [bachelorTable, bachelorRows(bachelors)],
    [masterTable, masterRows(masters)],
  ] as const;
  return database.transaction(async (client) => {
    await run(client, thesisLockSql);
    await openGuard(client, 'bachelor_theses');
    for (const [thesis, values] of rows) {
      if (!shrink) {
        await refuseShrinking(client, thesis, values.length);
      }
      await run(client, clearCommitteeSql(thesis));
      await run(client, clearThesesSql(thesis));
      await run(client, insertThesesSql(thesis), [json(values)]);
    }
    const committee = await rebuildCommittee(client);
    const unmatched = await run(client, unmatchedNamesSql);
    return {
      bachelors: bachelors.length,
      committee,
      masters: masters.length,
      unmatched: unmatchedRows.parse(unmatched.rows),
    };
  });
};

const fetchOrRefuse = async (
  fetcher: typeof fetch,
  url: string,
): Promise<Response> => {
  try {
    return await fetcher(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new ThesisImportError(`${url}: unreachable or too slow`, {
      cause: error,
      code: 'THESES_API_FAILED',
    });
  }
};

// The source over HTTP: GET, JSON, within a minute; any failure answers
// THESES_API_FAILED.
export const httpThesisSource =
  (fetcher: typeof fetch = fetch): ThesisSource =>
  async (url) => {
    const response = await fetchOrRefuse(fetcher, url);
    if (!response.ok) {
      throw new ThesisImportError(`${url}: HTTP ${String(response.status)}`, {
        code: 'THESES_API_FAILED',
      });
    }
    try {
      return await response.json();
    } catch (error) {
      throw new ThesisImportError(`${url}: not JSON`, {
        cause: error,
        code: 'THESES_API_FAILED',
      });
    }
  };
