import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { ActionContext } from '../directus/extensions/directus-extension-data-operations/src/coordination/action-support.js';
import type { Domain } from '../directus/extensions/directus-extension-data-operations/src/coordination/domains.js';

import { runAction } from '../directus/extensions/directus-extension-data-operations/src/coordination/actions.js';
import {
  conflictAttempts,
  conflictBackoffMs,
  isTransactionConflict,
  retryingConflicts,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/conflict-retry.js';
import {
  type SqlBinding,
  sqlStore,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/sql-port.js';
import {
  finishSql,
  releaseSql,
  retriesSql,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/sql-statements.js';
import { claimStaleAfterMs } from '../directus/extensions/directus-extension-data-operations/src/coordination/state.js';
import { statusAction } from '../directus/extensions/directus-extension-data-operations/src/coordination/status.js';
import { stateRowOf } from './automatic-processing-helpers.js';
import { FakeCoordination } from './data-coordination-helpers.js';

const processA = 'process-a';
const claimed = z.object({ claimed: z.literal(true), token: z.string() });
const planned = z.object({
  pages: z.array(
    z.object({ from: z.number(), to: z.number(), token: z.string() }),
  ),
});

const databaseError = (code: string, message: string) =>
  Object.assign(new Error(message), { code });
const deadlock = () => databaseError('40P01', 'deadlock detected');

const plainContext = (fake: FakeCoordination): ActionContext => ({
  owner: processA,
  staleAfterMs: claimStaleAfterMs,
  store: fake.store,
});

// The fake's store, whose transactions each throw the next of `failures`
// once their work has run (the fake rolls every write of it back, as
// PostgreSQL does for an aborted transaction); `between` runs before every
// later attempt, as another connection would while the loser waits.
const conflicting = (
  fake: FakeCoordination,
  failures: readonly Error[],
  between: () => void = () => {},
) => {
  const pending = [...failures];
  const counter = { attempts: 0 };
  const context: ActionContext = {
    ...plainContext(fake),
    store: {
      transaction: async (work) => {
        counter.attempts += 1;
        if (counter.attempts > 1) {
          between();
        }
        return fake.store.transaction(async (port) => {
          const result = await work(port);
          const failure = pending.shift();
          if (failure !== undefined) {
            throw failure;
          }
          return result;
        });
      },
    },
  };
  return { context, counter };
};

const claimToken = async (fake: FakeCoordination, domain: Domain) =>
  claimed.parse(
    await runAction(
      { action: 'claim', domain, retry: false },
      plainContext(fake),
    ),
  ).token;

// A completed history run with one Moodle user, and a pattern mapping
// edit that leaves enrollments pending. History line 1, held by four
// Moodle users, counts for course 1 in 2025/2026 through mapping 1.
const indexedHistory = async (): Promise<FakeCoordination> => {
  const fake = new FakeCoordination();
  fake.sourceIds.history = [1];
  fake.sourceIds.entries = [1];
  fake.counting = {
    courses: [1],
    explicit: [],
    mappings: [{ course: 1, id: 1, onlyInYear: null }],
    memberships: [1, 2, 3, 4].map((moodleUser) => ({ entry: 1, moodleUser })),
    years: [{ id: 1, label: '2025/2026' }],
  };
  const history = await claimToken(fake, 'history_index');
  const [historyPage] = planned.parse(
    await runAction(
      { action: 'plan_pages', source: 'history', token: history },
      plainContext(fake),
    ),
  ).pages;
  await runAction(
    {
      action: 'index_page',
      page: historyPage?.token ?? '',
      rows: [{ entries: [], id: 1 }],
      token: history,
    },
    plainContext(fake),
  );
  await runAction({ action: 'complete', token: history }, plainContext(fake));
  fake.sourceWrite('moodle_pattern_mappings');
  return fake;
};

const lineMatch = { entry: 1, pattern_mapping: 1, year_label: '2025/2026' };

// One enrollments run with one history line, staged and ready to complete.
const stagedEnrollments = async (): Promise<{
  fake: FakeCoordination;
  token: string;
}> => {
  const fake = await indexedHistory();
  const token = await claimToken(fake, 'enrollments');
  const [page] = planned.parse(
    await runAction(
      { action: 'plan_pages', source: 'entries', token },
      plainContext(fake),
    ),
  ).pages;
  await runAction(
    {
      action: 'stage_page',
      page: page?.token ?? '',
      rows: [lineMatch],
      token,
    },
    plainContext(fake),
  );
  return { fake, token };
};

describe('transaction conflicts', () => {
  test('are a deadlock or a serialization failure only', () => {
    expect(isTransactionConflict(deadlock())).toBeTruthy();
    expect(isTransactionConflict({ code: '40001' })).toBeTruthy();
    expect(isTransactionConflict({ code: '55P03' })).toBe(false);
    expect(isTransactionConflict({ code: '23505' })).toBe(false);
    expect(isTransactionConflict(new Error('deadlock detected'))).toBe(false);
    expect(isTransactionConflict(null)).toBe(false);
  });

  test('wait a short jittered, growing time before each retry', () => {
    for (let sample = 0; sample < 50; sample += 1) {
      expect(conflictBackoffMs(1)).toBeGreaterThanOrEqual(50);
      expect(conflictBackoffMs(1)).toBeLessThanOrEqual(100);
      expect(conflictBackoffMs(2)).toBeGreaterThanOrEqual(100);
      expect(conflictBackoffMs(2)).toBeLessThanOrEqual(200);
    }
  });

  test('run a transaction again with its retry count, at most three times', async () => {
    const seen: number[] = [];

    await expect(
      retryingConflicts(async (retries) => {
        seen.push(retries);
        if (retries < 2) {
          throw databaseError(retries === 0 ? '40P01' : '40001', 'conflict');
        }
        return 'done';
      }),
    ).resolves.toBe('done');
    expect(seen).toEqual([0, 1, 2]);
    expect(conflictAttempts).toBe(3);
  });
});

describe('the install after a database conflict', () => {
  test('runs the whole transaction again and records the retry', async () => {
    const { fake, token } = await stagedEnrollments();
    const revision = fake.data.sourceRevision;
    const { context, counter } = conflicting(fake, [deadlock()]);

    await expect(
      runAction({ action: 'complete', token }, context),
    ).resolves.toEqual({
      completed: true,
      counted: 1,
      domain: 'enrollments',
      installed: 1,
      retries: 1,
      revision,
    });
    expect(counter.attempts).toBe(2);
    expect(fake.data.enrollments).toEqual([
      { academicYear: 1, count: 4, course: 1, revision },
    ]);
    expect(fake.data.claim).toBeNull();
    await expect(statusAction(plainContext(fake))).resolves.toMatchObject({
      lastError: null,
      lastRun: { retries: 1 },
    });
  });

  test('fails with the original error once every attempt conflicted', async () => {
    const { fake, token } = await stagedEnrollments();
    const failures = [deadlock(), deadlock(), deadlock()];
    const { context, counter } = conflicting(fake, failures);

    await expect(
      runAction({ action: 'complete', token }, context),
    ).rejects.toBe(failures[2]);
    expect(counter.attempts).toBe(conflictAttempts);
    expect(fake.data.claim?.token).toBe(token);
    expect(fake.data.claim?.retries).toBe(0);
    expect(fake.data.enrollments).toEqual([]);
  });

  test('never retries another error', async () => {
    for (const failure of [
      databaseError('23505', 'duplicate key value'),
      databaseError('55P03', 'lock not available'),
      new Error('deadlock detected'),
    ]) {
      const { fake, token } = await stagedEnrollments();
      const { context, counter } = conflicting(fake, [failure]);

      await expect(
        runAction({ action: 'complete', token }, context),
      ).rejects.toBe(failure);
      expect(counter.attempts).toBe(1);
      expect(fake.data.claim?.token).toBe(token);
    }
  });

  test('refuses when the claim was lost between the attempts', async () => {
    const { fake, token } = await stagedEnrollments();
    const { context, counter } = conflicting(fake, [deadlock()], () => {
      fake.advance(claimStaleAfterMs + 1);
      fake.recoverOutside(claimStaleAfterMs);
    });

    await expect(
      runAction({ action: 'complete', token }, context),
    ).rejects.toMatchObject({ code: 'COORDINATION_CLAIM_MISMATCH' });
    expect(counter.attempts).toBe(2);
    expect(fake.data.enrollments).toEqual([]);
    expect(fake.data.lastRunRetries).toBe(0);
  });

  test('is overtaken when a source change committed between the attempts', async () => {
    const { fake, token } = await stagedEnrollments();
    const { context } = conflicting(fake, [deadlock()], () => {
      fake.sourceWrite('moodle_pattern_mappings', 'delete');
    });

    await expect(
      runAction({ action: 'complete', token }, context),
    ).rejects.toMatchObject({ code: 'COORDINATION_SOURCE_CHANGED' });
    await expect(statusAction(plainContext(fake))).resolves.toMatchObject({
      lastError: { code: 'SOURCE_CHANGED', retries: 1 },
      lastRun: { retries: 0 },
    });
    expect(fake.data.claim).toBeNull();
    expect(fake.data.enrollments).toEqual([]);
    expect(fake.data.dirtyDomains).toContain('enrollments');
  });

  test('runs a history page again after losing a label to the API, which it then finds', async () => {
    const fake = new FakeCoordination();
    fake.sourceIds.history = [1];
    const token = await claimToken(fake, 'history_index');
    const [page] = planned.parse(
      await runAction(
        { action: 'plan_pages', source: 'history', token },
        plainContext(fake),
      ),
    ).pages;
    // The API's insert of the same label commits while the loser waits;
    // it marks enrollments and publication, not the claimed index.
    const { context } = conflicting(fake, [deadlock()], () => {
      fake.data.history.entries.push({
        first_seen: null,
        id: 41,
        label: 'Synthetic Course',
      });
      fake.sourceWrite('moodle_course_entries');
    });

    await expect(
      runAction(
        {
          action: 'index_page',
          page: page?.token ?? '',
          rows: [{ entries: ['Synthetic Course'], id: 1 }],
          token,
        },
        context,
      ),
    ).resolves.toMatchObject({ entriesCreated: 0, membershipsWritten: 1 });
    expect(fake.data.history.entries.map(({ id }) => id)).toEqual([41]);
    expect(fake.data.claim?.staged).toEqual([page?.token]);
    // The page's retry is the run's: its completion and the status say so.
    await expect(
      runAction({ action: 'complete', token }, plainContext(fake)),
    ).resolves.toMatchObject({ completed: true, retries: 1 });
    expect(fake.data.lastRunRetries).toBe(1);
  });

  test('add up over every transaction of the run', async () => {
    const fake = await indexedHistory();
    const token = await claimToken(fake, 'enrollments');
    const once = () => conflicting(fake, [deadlock()]).context;
    const [page] = planned.parse(
      await runAction(
        { action: 'plan_pages', source: 'entries', token },
        once(),
      ),
    ).pages;
    await runAction(
      {
        action: 'stage_page',
        page: page?.token ?? '',
        rows: [lineMatch],
        token,
      },
      conflicting(fake, [deadlock(), deadlock()]).context,
    );

    expect(fake.data.claim?.retries).toBe(3);

    await expect(
      runAction({ action: 'complete', token }, once()),
    ).resolves.toMatchObject({ completed: true, retries: 4 });
    await expect(statusAction(plainContext(fake))).resolves.toMatchObject({
      claim: null,
      lastRun: { retries: 4 },
    });
    expect(fake.data.enrollments).toHaveLength(1);
  });
});

describe('the retries in SQL', () => {
  test('are added to the claim, kept by its completion or release and cleared with it', async () => {
    const sent: Array<{ bindings: SqlBinding[]; sql: string }> = [];
    const raw = async (sql: string, bindings: SqlBinding[] = []) => {
      sent.push({ bindings, sql });
      return sql.startsWith('SELECT')
        ? { rowCount: 1, rows: [stateRowOf()] }
        : { rowCount: 1, rows: [] };
    };
    const store = sqlStore({ raw, transaction: (work) => work({ raw }) });

    await store.transaction((port) => port.addRetries('token-a', processA, 2));

    expect(sent).toEqual([
      { bindings: [2, 'token-a', processA], sql: retriesSql },
    ]);
    expect(retriesSql).toContain(
      `SET "claim_retries" = "claim_retries" + ?::integer
WHERE "claim_token" = ? AND "claim_owner" = ?`,
    );
    expect(finishSql).toContain(`"last_run_retries" = "claim_retries"`);
    expect(releaseSql).toContain(
      `"last_error_retries" = CASE WHEN "claim_domain" = 'snapshot' THEN "last_error_retries" ELSE "claim_retries" END`,
    );

    for (const statement of [finishSql, releaseSql]) {
      expect(statement).toContain(`"claim_retries" = 0`);
    }
  });
});
