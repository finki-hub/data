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
import { releasedPublicationState } from './outcomes.js';
import { affected, first, json, matched, openGuard, run } from './sql-run.js';
import { stateRow, toState } from './sql-state.js';
import {
  claimSql,
  finishSql,
  graphSql,
  heartbeatSql,
  historySizesSql,
  insertSql,
  installSql,
  lockWaitSql,
  markSql,
  planSql,
  recordSql,
  releaseSql,
  ruleModesSql,
  stagedSql,
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
const markRow = z.object({
  dirty_domains: z.array(z.string()).nullable(),
  source_revision: z.number().int(),
});

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
  currentFingerprints: async () => {
    const result = await run(client, graphSql, [operationId]);
    return fingerprintsOfGraph(graphRowsSchema.parse(result.rows));
  },
  discardCandidates: async (token, page) => {
    await openGuard(client, 'data_operation_results');
    return affected(
      client,
      `DELETE FROM "data_operation_results" WHERE "claim_token" = ?${page === undefined ? '' : ' AND "page_token" = ?'}`,
      page === undefined ? [token] : [token, page],
    );
  },
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
      input.files === null ? null : json(input.files),
      input.token,
      input.owner,
      input.claimRevision,
      input.superseded,
      input.fingerprint,
    ]),
  heartbeat: (token, owner, leaseMs = 0) =>
    matched(client, heartbeatSql, [leaseMs, token, owner]),
  history: historySqlPort(client),
  insertCandidates: async (input: StagedRows) => {
    await openGuard(client, 'data_operation_results');
    return affected(client, insertSql, [
      input.token,
      input.page,
      input.revision,
      json(input.rows),
    ]);
  },
  // The install replaces every count row: the coordinator is the writer of
  // the derived counts and opens their guard first.
  installEnrollments: async (token, revision) => {
    await openGuard(client, 'course_enrollments');
    await run(client, 'DELETE FROM "course_enrollments"');
    return affected(client, installSql, [revision, token]);
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
  recordOutcomes: (token, owner, files) =>
    matched(client, recordSql, [json(files), token, owner]),
  recordStagedPage: (token, owner, page) =>
    matched(client, stagedSql, [page, token, owner]),
  // Every caller holds the singleton lock: the row read here is the one
  // the release updates.
  release: async (input: ReleaseInput) => {
    const { claim, publicationOutcomes } = toState(
      stateRow.parse(await first(client, stateSql(false))),
    );
    const files = input.files ?? null;
    return matched(client, releaseSql, [
      input.code,
      input.message ?? null,
      releasedPublicationState(
        input.failed,
        files ?? publicationOutcomes,
        claim?.revision ?? null,
      ),
      files === null ? null : json(files),
      input.token,
    ]);
  },
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
