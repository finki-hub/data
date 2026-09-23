import { z } from 'zod';

import type { PageRange } from '../page-state.js';
import type {
  ClaimInsert,
  CoordinationPort,
  CoordinationStore,
  MarkResult,
  ReleaseInput,
  StagedRows,
} from './port.js';

import { fingerprintOfGraph } from './fingerprint.js';
import { historySqlPort } from './history-sql.js';
import { stateRow, toState } from './sql-state.js';
import {
  claimSql,
  finishSql,
  graphSql,
  historySizesSql,
  insertSql,
  installSql,
  markSql,
  planSql,
  releaseSql,
  ruleModesSql,
  stagedSql,
  stateSql,
} from './sql-statements.js';
import {
  normaliseDomains,
  operationId,
  type OperationsState,
  type PageSource,
  pageSourceTables,
  publishedFiles,
} from './state.js';

export type SqlBinding = boolean | null | number | string;

export type SqlClient = {
  readonly raw: (sql: string, bindings?: SqlBinding[]) => PromiseLike<unknown>;
};

export type SqlDatabase = SqlClient & {
  readonly transaction: <T>(work: (trx: SqlClient) => Promise<T>) => Promise<T>;
};

const resultSchema = z.object({
  rowCount: z.number().nullable().optional(),
  rows: z.array(z.unknown()),
});

const countRow = z.object({ count: z.coerce.number().int().nonnegative() });
const idRows = z.array(z.object({ id: z.coerce.number().int() }));
const ruleModeRows = z.array(
  z.object({
    bytes: z.coerce.number().int().nonnegative(),
    id: z.coerce.number().int(),
    mode: z.string().nullable(),
  }),
);
const historySizeRows = z.array(
  z.object({
    bytes: z.coerce.number().int().nonnegative(),
    id: z.coerce.number().int(),
  }),
);
const graphRows = z.array(
  z.object({
    entry: z.string().nullable(),
    flow: z.string(),
    flow_options: z.unknown(),
    key: z.string().nullable(),
    operation: z.string().nullable(),
    options: z.unknown(),
    reject: z.string().nullable(),
    resolve: z.string().nullable(),
    trigger: z.string().nullable(),
    type: z.string().nullable(),
  }),
);
const markRow = z.object({
  dirty_domains: z.array(z.string()).nullable(),
  source_revision: z.number().int(),
});
const missingRowMessage =
  'The data_operations status row is missing; run npm run setup.';

const run = async (
  client: SqlClient,
  sql: string,
  bindings: SqlBinding[] = [],
) => resultSchema.parse(await client.raw(sql, bindings));

const affected = async (
  client: SqlClient,
  sql: string,
  bindings: SqlBinding[] = [],
): Promise<number> => {
  const result = await run(client, sql, bindings);
  return result.rowCount ?? 0;
};

const matched = async (
  client: SqlClient,
  sql: string,
  bindings: SqlBinding[],
): Promise<boolean> => (await affected(client, sql, bindings)) > 0;

const first = async (
  client: SqlClient,
  sql: string,
  bindings: SqlBinding[] = [],
): Promise<unknown> => {
  const result = await run(client, sql, bindings);
  const [row] = result.rows;
  if (row === undefined) {
    throw new Error(missingRowMessage);
  }
  return row;
};

const json = (value: unknown): string => JSON.stringify(value);

export const sqlPort = (client: SqlClient): CoordinationPort => ({
  adoptOwnRevision: (token, owner) =>
    matched(
      client,
      'UPDATE "data_operations" SET "claim_revision" = "source_revision" WHERE "claim_token" = ? AND "claim_owner" = ?',
      [token, owner],
    ),
  candidateCount: async (token) => {
    const row = await first(
      client,
      'SELECT COUNT(*)::integer AS "count" FROM "data_operation_results" WHERE "claim_token" = ?',
      [token],
    );
    return countRow.parse(row).count;
  },
  currentFingerprint: async () => {
    const result = await run(client, graphSql, [operationId]);
    return fingerprintOfGraph(graphRows.parse(result.rows));
  },
  discardCandidates: (token, page) =>
    affected(
      client,
      `DELETE FROM "data_operation_results" WHERE "claim_token" = ?${page === undefined ? '' : ' AND "page_token" = ?'}`,
      page === undefined ? [token] : [token, page],
    ),
  enrollmentSources: async () => {
    const rules = await run(client, ruleModesSql);
    const users = await run(client, historySizesSql);
    return {
      rules: ruleModeRows.parse(rules.rows),
      users: historySizeRows.parse(users.rows),
    };
  },
  ensureSingleton: async () => {
    await run(
      client,
      'INSERT INTO "data_operations" ("source_revision") SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM "data_operations") ON CONFLICT DO NOTHING',
    );
  },
  finish: (input) =>
    matched(client, finishSql, [
      json(input.dirtyDomains),
      ...publishedFiles.map((file) => input.files?.[file] ?? null),
      input.token,
      input.owner,
      input.sourceRevision,
      input.fingerprint,
    ]),
  heartbeat: (token, owner) =>
    matched(
      client,
      'UPDATE "data_operations" SET "claim_heartbeat_at" = clock_timestamp() WHERE "claim_token" = ? AND "claim_owner" = ?',
      [token, owner],
    ),
  history: historySqlPort(client),
  insertCandidates: (input: StagedRows) =>
    affected(client, insertSql, [
      input.token,
      input.page,
      input.revision,
      json(input.rows),
    ]),
  installEnrollments: async (token, revision) => {
    await run(client, 'DELETE FROM "course_enrollments"');
    return affected(client, installSql, [revision, token]);
  },
  markDomains: async (domains): Promise<MarkResult> => {
    const row = markRow.parse(
      await first(client, markSql, [json(normaliseDomains(domains))]),
    );
    return {
      dirtyDomains: normaliseDomains(row.dirty_domains ?? []),
      sourceRevision: row.source_revision,
    };
  },
  readState: async (lock): Promise<OperationsState> =>
    toState(stateRow.parse(await first(client, stateSql(lock)))),
  recordStagedPage: (token, owner, page) =>
    matched(client, stagedSql, [page, token, owner]),
  release: (input: ReleaseInput) =>
    matched(client, releaseSql, [
      input.code,
      input.failed ? 'failed' : 'idle',
      input.token,
    ]),
  ruleModes: async () => {
    const rules = await run(client, ruleModesSql);
    return ruleModeRows.parse(rules.rows);
  },
  sourceIds: async (source: PageSource) => {
    const result = await run(
      client,
      `SELECT "id" FROM "${pageSourceTables[source]}" ORDER BY "id"`,
    );
    return idRows.parse(result.rows).map(({ id }) => id);
  },
  storePlan: (token, owner, pages: readonly PageRange[]) =>
    matched(client, planSql, [json(pages), token, owner]),
  takeClaim: (input: ClaimInsert) =>
    matched(client, claimSql, [
      input.token,
      input.owner,
      input.domain,
      input.fingerprint,
      json(normaliseDomains(input.dirtyDomains)),
      input.domain,
      input.sourceRevision,
    ]),
});

export const sqlStore = (database: SqlDatabase): CoordinationStore => ({
  transaction: (work) => database.transaction((trx) => work(sqlPort(trx))),
});
