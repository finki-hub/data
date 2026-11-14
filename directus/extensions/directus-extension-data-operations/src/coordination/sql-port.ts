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

import { normaliseDomains } from './domains.js';
import { touchesInputs } from './failures.js';
import { fingerprintsOfGraph, graphRowsSchema } from './fingerprint.js';
import { historySqlPort } from './history-sql.js';
import { affected, first, json, matched, openGuard, run } from './sql-run.js';
import { stateRow, toState } from './sql-state.js';
import {
  claimSql,
  countedLinesSql,
  enrollmentsSql,
  finishSql,
  graphSql,
  heartbeatSql,
  lockWaitSql,
  markSql,
  planSql,
  releaseSql,
  retriesSql,
  stagedSql,
  stageSql,
  stateSql,
} from './sql-statements.js';
import {
  operationId,
  type OperationsState,
  type PageSource,
  pageSourceTables,
} from './state.js';

export type SqlBinding = boolean | null | number | string;

export type SqlClient = {
  readonly raw: (sql: string, bindings?: SqlBinding[]) => PromiseLike<unknown>;
};

export type SqlDatabase = SqlClient & {
  readonly transaction: <T>(work: (trx: SqlClient) => Promise<T>) => Promise<T>;
};

const countRow = z.object({ count: z.coerce.number().int().nonnegative() });
const idRows = z.array(z.object({ id: z.coerce.number().int() }));
const markRow = z.object({
  dirty_domains: z.array(z.string()).nullable(),
  source_revision: z.number().int(),
});

export const sqlPort = (client: SqlClient): CoordinationPort => ({
  addRetries: (token, owner, retries) =>
    matched(client, retriesSql, [retries, token, owner]),
  adoptOwnRevision: (token, owner) =>
    matched(
      client,
      'UPDATE "data_operations" SET "claim_revision" = "source_revision" WHERE "claim_token" = ? AND "claim_owner" = ?',
      [token, owner],
    ),
  candidateCount: async (token) => {
    const row = await first(
      client,
      'SELECT COUNT(*)::integer AS "count" FROM "data_operation_matches" WHERE "claim_token" = ?',
      [token],
    );
    return countRow.parse(row).count;
  },
  currentFingerprints: async () => {
    const result = await run(client, graphSql, [operationId]);
    return fingerprintsOfGraph(graphRowsSchema.parse(result.rows));
  },
  discardCandidates: async (token, page) => {
    await openGuard(client, 'data_operation_matches');
    return affected(
      client,
      `DELETE FROM "data_operation_matches" WHERE "claim_token" = ?${page === undefined ? '' : ' AND "page_token" = ?'}`,
      page === undefined ? [token] : [token, page],
    );
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
      input.token,
      input.owner,
      input.claimRevision,
      input.fingerprint,
    ]),
  heartbeat: (token, owner) => matched(client, heartbeatSql, [token, owner]),
  history: historySqlPort(client),
  insertCandidates: async (input: StagedRows) => {
    await openGuard(client, 'data_operation_matches');
    return affected(client, stageSql, [
      input.token,
      input.page,
      json(input.rows),
    ]);
  },
  // The install replaces every counted line, then every count row: the
  // coordinator is the writer of both and opens their guards first.
  installEnrollments: async (token, revision) => {
    await openGuard(client, 'moodle_counted_lines');
    await openGuard(client, 'course_enrollments');
    await run(client, 'DELETE FROM "moodle_counted_lines"');
    const counted = await affected(client, countedLinesSql, [token]);
    await run(client, 'DELETE FROM "course_enrollments"');
    const installed = await affected(client, enrollmentsSql, [revision]);
    return { counted, installed };
  },
  limitLockWait: async (ms) => {
    await run(client, lockWaitSql, [String(ms)]);
  },
  markDomains: async (domains): Promise<MarkResult> => {
    const row = markRow.parse(
      await first(client, markSql, [
        touchesInputs(domains, 'history_index'),
        touchesInputs(domains, 'enrollments'),
        json(normaliseDomains(domains)),
      ]),
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
      input.message ?? null,
      input.token,
    ]),
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
      input.sourceRevision,
    ]),
});

export const sqlStore = (database: SqlDatabase): CoordinationStore => ({
  transaction: (work) => database.transaction((trx) => work(sqlPort(trx))),
});
