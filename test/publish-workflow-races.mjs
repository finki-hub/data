import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import { ruleMode } from '../directus/extensions/directus-extension-data-operations/src/rule-modes.js';
import { markPendingFlowId } from '../src/flows/mark-pending.js';
import { createRows } from './fixture-seed.mjs';
import { forcesInstallDeadlock } from './install-deadlock.mjs';
import {
  assertIntact,
  publishes,
  ruleOf,
  setPattern,
  settlesCounted,
  untilObserved,
} from './publish-workflow-helpers.mjs';
import {
  isCurrent,
  psql,
  restartDirectus,
  settle,
  waitForStatus,
} from './relational/automatic-processing-helpers.mjs';
import { get, remove, status } from './relational/history-index-helpers.mjs';
import { runFlow } from './relational/operations-helpers.mjs';

// The race scenarios of the complete workflow suite: a Directus restart
// while a count run holds its claim, a source edit while a run holds its
// claim, parent deletes while a run installs its counts (follow-up 11),
// and a deadlock forced at the install. Each of the first three must catch
// its run in that state: an attempt that came too late (the run was
// already over) is recounted and tried again, and the scenario fails
// unless one attempt caught it. The active snapshot and every published
// object stay intact throughout.

const legacy = ruleMode('legacy_regex').mode;

const enrollmentsClaimed = (target) =>
  waitForStatus(target, (report) => report.claim?.domain === 'enrollments', {
    limitMs: 60_000,
    pollMs: 100,
  });

// A restart while the counts run: the new process has another identity,
// sees the old process's claim, never steals it by time alone, releases it
// once its heartbeat is stale (CLAIM_INTERRUPTED) and the next tick
// recounts; the snapshot and the objects are untouched.
export const recoversAfterRestart = async (context) => {
  const { containers, t, target } = context;
  const pair = { course: 2, year: 1 };
  const { rule } = await ruleOf(context, pair);
  const caught = await untilObserved(
    'a restart while the count run holds its claim',
    async (attempt) => {
      await setPattern(
        context,
        pair,
        `${rule.pattern}|Synthetic Restart Line ${attempt}`,
      );
      const claimed = await enrollmentsClaimed(target);
      const pings = await restartDirectus(target, containers.directus);
      const seen = await status(target);
      assert.notEqual(seen.process, claimed.report.process);
      if (seen.claim?.owner !== claimed.report.claim.owner) {
        await settlesCounted(context, 'after a restart that came too late');
        return { observed: false };
      }
      return {
        after: seen,
        observed: true,
        polls: pings,
        running: claimed.report,
      };
    },
  );
  const { after, polls, running } = caught;
  assert.equal(after.claim.ownedByThisProcess, false);
  assert.equal(after.claim.revision, running.claim.revision);
  await settlesCounted(context, 'after the restart');
  const settled = await status(target);
  assert.equal(settled.lastError?.code, 'CLAIM_INTERRUPTED');
  assert.equal(settled.lastError?.domain, 'enrollments');
  await assertIntact(context, 'restart');
  await publishes(context);
  t.diagnostic(
    `restart during an enrollments run (claim revision ${running.claim.revision}, attempt ${caught.attempts}); ping after ${polls} polls; the new process saw the old claim and released it as ${settled.lastError.code}; recounted and published`,
  );
};

// A source edit that commits while a count run holds its claim is never
// lost: the run is overtaken and the next run counts the edit (the oracle
// includes it).
export const keepsConcurrentEdits = async (context) => {
  const { t, target } = context;
  const edited = { course: 3, year: 2 };
  const starterPair = { course: 5, year: 3 };
  const { rule } = await ruleOf(context, edited);
  const { rule: model } = await ruleOf(context, { course: 4, year: 2 });
  const { rule: starter } = await ruleOf(context, starterPair);
  let caught;
  try {
    caught = await untilObserved(
      'an edit while the count run holds its claim',
      async (attempt) => {
        await setPattern(
          context,
          starterPair,
          `${starter.pattern}|Synthetic Start ${attempt}`,
        );
        const claimed = await enrollmentsClaimed(target);
        const { claim } = claimed.report;
        await setPattern(
          context,
          edited,
          `${model.pattern}|Synthetic Concurrent ${attempt}`,
        );
        const during = await status(target);
        const observed =
          during.claim?.domain === 'enrollments' &&
          during.claim.revision === claim.revision &&
          during.revisions.source > claim.revision;
        await settlesCounted(
          context,
          observed ? 'after an edit during a run' : 'after a late edit',
        );
        await assertIntact(context, 'concurrent edit');
        return { observed, revision: claim.revision };
      },
    );
  } finally {
    await setPattern(context, edited, rule.pattern);
    await setPattern(context, starterPair, starter.pattern);
  }
  await settlesCounted(context, 'after the edits were undone');
  await assertIntact(context, 'the edits undone');
  t.diagnostic(
    `an edit committed while the run of revision ${caught.revision} held its claim (attempt ${caught.attempts}) was counted by the next run; objects intact`,
  );
};

const deadlocks = async ({ containers }) => {
  const [[value = '0'] = []] = await psql(
    "SELECT deadlocks FROM pg_stat_database WHERE datname = 'directus'",
    containers.database,
  );
  return Number(value);
};

// The deadlocks counted since `before`, waiting up to 15 s for one: a
// backend reports its statistics a moment after its transaction ended.
const deadlocksSince = async (context, before) => {
  let delta = 0;
  for (let tries = 0; delta === 0 && tries < 30; tries += 1) {
    if (tries > 0) await sleep(500);
    delta = (await deadlocks(context)) - before;
  }
  return delta;
};

// The moment a count run has staged every page and installs, or the end
// of the run when the poll never saw that moment.
export const stagedOrOver = (report) =>
  report.claim === null
    ? report.domains.enrollments.current
    : report.claim.domain === 'enrollments' &&
      report.claim.pages !== null &&
      report.claim.staged >= report.claim.pages;

// Waits for `until` and collects meanwhile every run that completed after
// `before`, with its retries after a database conflict, and every refusal
// or failure recorded after it, with its retries. Parent deletes never fail a
// run: the install that meets them completes, after a retry when it lost a
// deadlock (conflict-retry.ts), or is overtaken like any run a committed
// edit overtakes (SOURCE_CHANGED); either way the next run counts the
// deletes.
export const watchesInstall = async (target, { before, until, wait }) => {
  const retries = new Map();
  const errors = new Map();
  const { report } = await waitForStatus(
    target,
    (seen) => {
      if (seen.lastRun.finishedAt !== before.lastRun.finishedAt) {
        retries.set(seen.lastRun.finishedAt, seen.lastRun.retries);
      }
      if (
        seen.lastError !== null &&
        seen.lastError.at !== before.lastError?.at
      ) {
        errors.set(seen.lastError.at, {
          code: seen.lastError.code,
          retries: seen.lastError.retries,
        });
      }
      return until(seen);
    },
    wait,
  );
  const install = {
    errors: errors.values().toArray(),
    retries: retries.values().toArray(),
  };
  assert.ok(
    install.errors.every(({ code }) => code === 'SOURCE_CHANGED'),
    `the parent deletes failed a run: ${JSON.stringify(install)}`,
  );
  return { install, report };
};

// Three courses with a legacy rule per published year, deleted in parallel
// once a count run has staged every page; answers whether the deletes met
// the install, and what they cost.
const deletesAtInstall = async (context, attempt) => {
  const { state, target } = context;
  const doomed = await createRows(
    target,
    'courses',
    [1, 2, 3].map((index) => ({
      name: `Synthetic Doomed Course ${attempt}.${index}`,
      pattern_mappings: [],
    })),
  );
  const published = state.seeded.years.filter((year) => year.published);
  await createRows(
    target,
    'course_enrollment_rules',
    doomed.flatMap((course) =>
      published.map((year) => ({
        academic_year: year.id,
        course,
        mode: legacy,
        pattern: `Synthetic Doomed Pattern ${course}`,
      })),
    ),
  );
  await settle(target);
  const before = await deadlocks(context);
  const marked = await runFlow(target, target.token, {
    id: markPendingFlowId,
    values: { domains: ['enrollments'] },
  });
  assert.equal(marked.status, 200, JSON.stringify(marked.body));
  const staged = await waitForStatus(target, stagedOrOver, {
    limitMs: 90_000,
    pollMs: 25,
  });
  const deleteMs = await Promise.all(
    doomed.map(async (course) => {
      const started = performance.now();
      await remove(target, `/items/courses/${course}`);
      return Math.round(performance.now() - started);
    }),
  );
  const { install } = await watchesInstall(target, {
    before: staged.report,
    until: isCurrent('enrollments'),
    wait: { limitMs: 300_000, pollMs: 100 },
  });
  await settlesCounted(context, 'after the parent deletes');
  const left = await get(
    target,
    `/items/course_enrollments?aggregate[count]=*&filter[course][_in]=${doomed.join(',')}`,
  );
  assert.equal(Number(left[0]?.count ?? 0), 0);
  await assertIntact(context, 'parent deletes');
  return {
    deadlocks: (await deadlocks(context)) - before,
    deleteMs,
    install,
    observed: staged.report.claim !== null,
    pages: staged.report.claim?.pages ?? null,
  };
};

// Follow-up 11: parent deletes (cascading into course_enrollments) that
// land while a run installs leave consistent counts once the runs settle.
export const deletesParentsAtInstall = async (context) => {
  const { state, t } = context;
  const caught = await untilObserved(
    'parent deletes while every page is staged',
    (attempt) => deletesAtInstall(context, attempt),
  );
  Object.assign(state, {
    followUp11: {
      attempts: caught.attempts,
      deadlocks: caught.deadlocks,
      deleteMs: caught.deleteMs,
      install: caught.install,
      pages: caught.pages,
    },
  });
  t.diagnostic(
    `parent deletes with all ${caught.pages} pages staged (attempt ${caught.attempts}): ${JSON.stringify(state.followUp11)}; counts consistent, objects intact`,
  );
  await publishes(context);
};

// An install that loses a deadlock runs again in place: a test-owned
// session forces the deadlock at the install (install-deadlock.mjs), and
// the run completes at its claimed revision with one retry in the status,
// nothing refused or failed, and the counts of the oracle.
export const retriesInstallAfterDeadlock = async (context) => {
  const { containers, t, target } = context;
  const { report: before } = await settle(target);
  const deadlocksBefore = await deadlocks(context);
  const [, marked] = await Promise.all([
    forcesInstallDeadlock(containers.database),
    runFlow(target, target.token, {
      id: markPendingFlowId,
      values: { domains: ['enrollments'] },
    }),
  ]);
  assert.equal(marked.status, 200, JSON.stringify(marked.body));
  const { report } = await waitForStatus(target, isCurrent('enrollments'), {
    limitMs: 300_000,
    pollMs: 250,
  });
  const run = {
    deadlocks: await deadlocksSince(context, deadlocksBefore),
    lastRun: report.lastRun,
  };
  assert.notEqual(report.lastRun.finishedAt, before.lastRun.finishedAt);
  assert.equal(report.lastRun.retries, 1, JSON.stringify(run));
  assert.ok(run.deadlocks >= 1, JSON.stringify(run));
  assert.equal(report.lastError?.at, before.lastError?.at, 'nothing refused');
  await settlesCounted(context, 'after the retried install');
  await assertIntact(context, 'retried install');
  t.diagnostic(
    `an install that lost a forced deadlock completed in place: ${JSON.stringify(run)}; counts consistent, objects intact`,
  );
};
