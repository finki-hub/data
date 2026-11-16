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
  thesisLockSql,
  unmatchedNamesSql,
} from './sql.js';

// The thesis import: reads every bachelor's and master's thesis from the
// theses APIs of theses-listing, replaces the stored theses with them and
// rebuilds thesis_committee, all in one transaction.

export const defaultBachelorsApi = 'https://bachelors-api.finki-hub.com';
export const defaultMastersApi = 'https://masters-api.finki-hub.com';

export const bachelorsPath = '/diplomas';
export const mastersPath = '/masters';

export type ThesisApis = {
  readonly bachelors: string;
  readonly masters: string;
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

// Rebuilds thesis_committee from the stored theses, the staff and
// staff_aliases. The caller's transaction must not have opened another
// writer's guard.
export const rebuildCommittee = async (
  client: SqlClient,
): Promise<{
  readonly committee: number;
  readonly unmatched: readonly UnmatchedName[];
}> => {
  await run(client, thesisLockSql);
  await openGuard(client, 'thesis_committee');
  await run(client, clearCommitteeSql);
  const committee = await affected(client, insertCommitteeSql);
  const unmatched = await run(client, unmatchedNamesSql);
  return { committee, unmatched: unmatchedRows.parse(unmatched.rows) };
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
  database: SqlDatabase,
  source: ThesisSource,
  apis: ThesisApis,
): Promise<ThesisImportSummary> => {
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
  const rows = [...bachelorRows(bachelors), ...masterRows(masters)];
  return database.transaction(async (client) => {
    await run(client, thesisLockSql);
    await openGuard(client, 'theses');
    await run(client, clearCommitteeSql);
    await run(client, clearThesesSql);
    await run(client, insertThesesSql, [json(rows)]);
    const rebuilt = await rebuildCommittee(client);
    return {
      bachelors: bachelors.length,
      committee: rebuilt.committee,
      masters: masters.length,
      unmatched: rebuilt.unmatched,
    };
  });
};

// The source over HTTP: GET, JSON, within a minute.
export const httpThesisSource =
  (fetcher: typeof fetch = fetch): ThesisSource =>
  async (url) => {
    const response = await fetcher(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(60_000),
    });
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
