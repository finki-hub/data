import { describe, expect, test } from 'vitest';

import type { ActionContext } from '../directus/extensions/directus-extension-data-operations/src/coordination/action-support.js';

import { runAction } from '../directus/extensions/directus-extension-data-operations/src/coordination/actions.js';
import { verifyClaim } from '../directus/extensions/directus-extension-data-operations/src/coordination/decisions.js';
import {
  abandonedCode,
  interruptedCode,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/failures.js';
import {
  type SqlBinding,
  sqlStore,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/sql-port.js';
import {
  claimInputRevision,
  stateRow,
  toState,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/sql-state.js';
import {
  finishSql,
  lockWaitSql,
  markSql,
  planSql,
  stagedSql,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/sql-statements.js';
import {
  claimLockWaitMs,
  claimStaleAfterMs,
  type Domain,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/state.js';
import {
  sourceInvalidationSql,
  splitSqlStatements,
} from '../directus/extensions/directus-extension-data-operations/src/source-invalidation-sql.js';
import {
  claimed,
  claimNext,
  context,
  fail,
  finish,
  graphFingerprint,
  settled,
  stateRowOf,
  status,
  tick,
} from './automatic-processing-helpers.js';

// A calculation depends only on the tables that mark it or an upstream
// domain, so only those statements overtake its run or lift its failure;
// a restart mid-run reruns it once on its own; a tick never waits long
// for the status row lock.

const history = 'history_index';
const enrollments = 'enrollments';
const publication = 'publication';
const nextClaim = {
  action: 'claim',
  domain: 'next_calculation',
  retry: false,
} as const;

// A claim of `domain` at revision 7 checked after a source statement that
// took the source revision to 8 and the given input revisions.
const afterStatement = (
  domain: Domain,
  inputs: { enrollments: number; history_index: number },
) =>
  verifyClaim(
    toState(
      stateRow.parse(
        stateRowOf({
          claim_domain: domain,
          claim_fingerprint: graphFingerprint,
          claim_heartbeat_age_ms: 10,
          claim_owner: 'process-a',
          claim_revision: 7,
          claim_token: 'held',
          enrollments_input_revision: inputs.enrollments,
          history_index_input_revision: inputs.history_index,
          source_revision: 8,
        }),
      ),
    ),
    { owner: 'process-a', token: 'held' },
  );

describe('which statements overtake a run', () => {
  test('only a statement that touched the claimed domain’s inputs, while a publication claim reads everything', () => {
    expect(
      afterStatement(enrollments, { enrollments: 8, history_index: 7 }),
    ).toBe('source_changed');
    expect(
      afterStatement(enrollments, { enrollments: 7, history_index: 7 }),
    ).toBe('ok');
    expect(afterStatement(history, { enrollments: 8, history_index: 8 })).toBe(
      'source_changed',
    );
    expect(afterStatement(history, { enrollments: 8, history_index: 7 })).toBe(
      'ok',
    );
    expect(
      afterStatement(publication, { enrollments: 7, history_index: 7 }),
    ).toBe('source_changed');
  });
});

describe('input revisions and interruptions', () => {
  test('keeps a calculation running and its failure blocking through publication-only edits', async () => {
    const fake = settled('course_enrollment_rules');
    const run = await claimNext(fake);

    // An editor saves a room, a staff member and a course mid-run: none
    // of them feeds the counts, so the run is not discarded.
    for (const table of ['rooms', 'staff', 'courses']) {
      fake.sourceWrite(table);
    }

    await expect(finish(fake, run.token)).resolves.toMatchObject({
      completed: true,
      domain: enrollments,
      revision: run.revision,
    });
    expect(fake.data.completedRevision).toBe(run.revision);
    expect(fake.data.sourceRevision).toBe(run.revision + 3);
    expect(fake.data.dirtyDomains).toEqual([publication]);

    // A history run is not discarded by an edit of the counts' own inputs
    // either; the counts stay dirty for the next tick.
    fake.sourceWrite('moodle_users');
    const index = await claimNext(fake);
    fake.sourceWrite('moodle_course_mappings');

    await expect(finish(fake, index.token)).resolves.toMatchObject({
      completed: true,
      domain: history,
    });
    expect(fake.data.dirtyDomains).toEqual([enrollments, publication]);

    const counts = await claimNext(fake);
    await fail(
      fake,
      counts.token,
      'Rule 4 has a pattern that does not compile',
    );
    fake.sourceWrite('rooms');
    fake.sourceWrite('discord_channels');
    await runAction({ action: 'mark', domains: [publication] }, context(fake));

    await expect(tick(fake)).resolves.toMatchObject({
      claimed: false,
      domain: enrollments,
      reason: 'failed',
    });

    const held = await status(fake);

    expect(held.lastError?.blocking).toBeTruthy();

    // A change to the counts' inputs lifts the failure.
    fake.sourceWrite('academic_years');

    await expect(claimNext(fake)).resolves.toMatchObject({
      domain: enrollments,
    });
  });

  test('moves the input revisions with every statement or mark that touches a calculation or its upstream', async () => {
    const fake = settled();
    const inputs = () => ({ ...fake.data.inputRevisions });

    fake.sourceWrite('students');

    expect(inputs()).toEqual({ enrollments: 0, history_index: 0 });

    fake.sourceWrite('moodle_course_mappings');

    expect(inputs()).toEqual({ enrollments: 2, history_index: 0 });

    fake.sourceWrite('moodle_course_entries', 'delete');

    expect(inputs()).toEqual({ enrollments: 3, history_index: 3 });

    for (const [domains, expected] of [
      [[publication], { enrollments: 3, history_index: 3 }],
      [[enrollments], { enrollments: 5, history_index: 3 }],
      [[history], { enrollments: 6, history_index: 6 }],
    ] as const) {
      await runAction({ action: 'mark', domains: [...domains] }, context(fake));

      expect(inputs()).toEqual(expected);
    }

    const report = await status(fake);

    expect(report.revisions).toMatchObject({
      inputs: { enrollments: 6, history_index: 6 },
      source: 6,
    });
  });

  test('reruns a calculation interrupted by a restart once, and waits for a retry when it is interrupted again', async () => {
    const fake = settled('course_enrollment_rules');
    const first = await claimNext(fake);
    fake.advance(claimStaleAfterMs + 1);

    // The process that held the claim is gone: the next tick of the
    // restarted process releases it and runs the domain again at once.
    const rerun = claimed.parse(await tick(fake, 'process-b'));

    expect(rerun).toMatchObject({ domain: enrollments });
    expect(rerun.token).not.toBe(first.token);
    expect(fake.data.lastError).toMatchObject({
      code: interruptedCode,
      domain: enrollments,
      revision: first.revision,
    });

    const interrupted = await status(fake);

    expect(interrupted.lastError?.blocking).toBeFalsy();

    // Interrupted again at the same inputs and graph: a crash loop. It is
    // released as abandoned, and the schedule leaves it failed.
    fake.sourceWrite('rooms');
    fake.advance(claimStaleAfterMs + 1);

    for (let index = 0; index < 3; index += 1) {
      await expect(tick(fake)).resolves.toMatchObject({
        claimed: false,
        domain: enrollments,
        error: abandonedCode,
        reason: 'failed',
      });
    }

    const report = await status(fake);

    expect(report.domains.enrollments.state).toBe('failed');
    expect(report.lastError).toMatchObject({
      blocking: true,
      code: abandonedCode,
      revision: rerun.revision,
    });

    // Mark pending is the explicit retry; its run counts as a first
    // interruption again if it is cut short too.
    await runAction({ action: 'mark', domains: [enrollments] }, context(fake));
    const retried = await claimNext(fake);
    fake.advance(claimStaleAfterMs + 1);

    await expect(claimNext(fake)).resolves.toMatchObject({
      domain: enrollments,
    });
    expect(retried.domain).toBe(enrollments);
    expect(fake.data.lastError?.code).toBe(interruptedCode);
  });
});

describe('the claim transaction', () => {
  test('bounds the claim lock wait and answers busy when a source transaction holds the status row', async () => {
    const fake = settled();

    await tick(fake);

    expect(fake.lockWaits).toEqual([claimLockWaitMs]);
    expect(claimLockWaitMs).toBe(2_000);

    const sent: Array<{ bindings: SqlBinding[]; sql: string }> = [];
    const locked = (code: string): ActionContext => {
      const raw = async (sql: string, bindings: SqlBinding[] = []) => {
        sent.push({ bindings, sql });
        if (sql.includes(' FOR UPDATE')) {
          throw Object.assign(new Error('lock refused'), { code });
        }
        return { rowCount: 1, rows: [] };
      };
      return {
        owner: 'process-a',
        staleAfterMs: claimStaleAfterMs,
        store: sqlStore({ raw, transaction: (work) => work({ raw }) }),
      };
    };

    await expect(runAction(nextClaim, locked('55P03'))).resolves.toEqual({
      claimed: false,
      reason: 'busy',
    });
    expect(sent[0]).toEqual({ bindings: ['2000'], sql: lockWaitSql });
    // Any other database error is not a busy answer.
    await expect(runAction(nextClaim, locked('40P01'))).rejects.toMatchObject({
      code: '40P01',
    });
  });

  test('moves the input revisions in the trigger function and in mark by the same rule', async () => {
    const functionStatement = splitSqlStatements(sourceInvalidationSql)[2];

    // Each calculation moves with its own domain and every upstream one,
    // exactly the domains touchesInputs checks.
    for (const calculation of [history, enrollments] as const) {
      const upstream = [history, enrollments]
        .slice(0, calculation === history ? 1 : 2)
        .map((domain) => `'${domain}'`)
        .join(', ');

      expect(functionStatement).toContain(
        `"${calculation}_input_revision" = CASE WHEN affected && ARRAY[${upstream}] THEN "source_revision" + 1 ELSE "${calculation}_input_revision" END,`,
      );
    }

    const sent: SqlBinding[][] = [];
    const raw = async (_sql: string, bindings: SqlBinding[] = []) => {
      sent.push(bindings);
      return {
        rowCount: 1,
        rows: [{ dirty_domains: [enrollments], source_revision: 9 }],
      };
    };
    const store = sqlStore({ raw, transaction: (work) => work({ raw }) });

    const marks: Domain[][] = [[publication], [enrollments], [history]];

    for (const domains of marks) {
      await store.transaction((port) => port.markDomains(domains));
    }

    expect(sent).toEqual([
      [false, false, '["publication"]'],
      [false, true, '["enrollments"]'],
      [true, true, '["history_index"]'],
    ]);
  });

  test('guards every write of a live claim by the claimed domain’s inputs, never by the global revision', () => {
    for (const sql of [stagedSql, planSql, finishSql]) {
      expect(sql).toContain(`${claimInputRevision} <= "claim_revision"`);
      expect(sql).not.toContain('"source_revision" = "claim_revision"');
      expect(sql).not.toContain('"source_revision" = ?');
    }

    expect(claimInputRevision).toContain(
      `WHEN 'enrollments' THEN COALESCE("enrollments_input_revision", "source_revision")`,
    );
    expect(markSql).toContain(
      `"history_index_input_revision" = CASE WHEN ?::boolean THEN "source_revision" + 1 ELSE "history_index_input_revision" END`,
    );
  });
});
