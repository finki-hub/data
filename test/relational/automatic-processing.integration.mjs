import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dispatcherFlowId } from '../../src/flows/count-enrollments.js';
import { historyFlowIds } from '../../src/flows/history-page-flows.js';
import { historyIndexFlows } from '../../src/flows/index-histories.js';
import {
  automaticProcessingFlows,
  processPendingFlow,
} from '../../src/flows/process-pending.js';
import { runSetup } from '../../src/setup.js';
import { assertMarkerPresent, targetFrom } from '../isolated-target.mjs';
import {
  checksAfterSeeding,
  cleansUp,
  freshState,
} from './automatic-processing-checks.mjs';
import {
  afterTick,
  countsOf,
  courses,
  createMany,
  expectedCounts,
  isCurrent,
  latencyOf,
  lines,
  record,
  runsSince,
  seedUsers,
  settle,
  waitForStatus,
  wallClock,
  years,
} from './automatic-processing-helpers.mjs';
import {
  adminRequest,
  pauseAutomaticProcessing,
  userCollections,
  withDataModel,
} from './data-model-helpers.mjs';
import {
  collator,
  get,
  patch,
  remove,
  status,
} from './history-index-helpers.mjs';

const byText = (left, right) => collator.compare(left, right);
const byKey = (left, right) => collator.compare(left.key, right.key);
const nothingToResume = () => Promise.resolve();

// Setup installs every template once, the schedule last, each live exactly
// as defined; the schedule then settles the fresh project on its own.
const installsTemplates = async ({ directus, state, t, target }) => {
  const listed = await get(target, '/flows?fields=id&limit=-1');
  const present = new Set(listed.map(({ id }) => id));
  const templates = [...historyIndexFlows, ...automaticProcessingFlows];
  state.templatesCreated = templates
    .map(({ id }) => id)
    .filter((id) => !present.has(id));
  const summary = await runSetup(directus);
  const names = new Set([...summary.flows.created, ...summary.flows.skipped]);
  for (const flow of templates) assert.ok(names.has(flow.name), flow.name);
  if (summary.flows.created.includes(processPendingFlow.name)) {
    assert.equal(summary.flows.created.at(-1), processPendingFlow.name);
  }
  for (const flow of templates) {
    const live = await get(
      target,
      `/flows/${flow.id}?fields=status,trigger,accountability,operation,options`,
    );
    if (flow.id === processPendingFlow.id && live.status !== 'active') {
      // A suite interrupted while it paused the schedule left it inactive.
      await patch(target, `/flows/${flow.id}`, { status: 'active' });
      live.status = 'active';
    }
    assert.deepEqual(live, {
      accountability: 'activity',
      operation: flow.entry,
      options: flow.options,
      status: 'active',
      trigger: flow.trigger,
    });
    const operations = await get(
      target,
      `/operations?fields=key,type,options,resolve,reject&filter[flow][_eq]=${flow.id}&limit=-1`,
    );
    assert.deepEqual(
      operations.toSorted(byKey),
      flow.operations
        .map(({ key, options, reject, resolve, type }) => ({
          key,
          options,
          reject,
          resolve,
          type,
        }))
        .toSorted(byKey),
    );
  }
  const settled = await settle(target);
  assert.deepEqual(settled.report.pending, ['publication']);
  state.fingerprint = settled.report.fingerprints.current.calculation;
  t.diagnostic(`fresh project settled after ${settled.elapsedMs} ms`);
};

const seedCatalog = async (target, state) => {
  const courseIds = await createMany(
    target,
    'courses',
    Object.values(courses).map((name) => ({ name })),
  );
  for (const [index, key] of Object.keys(courses).entries()) {
    state.courses.set(key, courseIds[index]);
  }
  const yearIds = await createMany(
    target,
    'academic_years',
    Object.values(years).map((label, index) => ({ label, sort: index + 1 })),
  );
  for (const [index, key] of Object.keys(years).entries()) {
    state.years.set(key, yearIds[index]);
  }
};

const seedRules = async (target, state) => {
  const course = (key) => state.courses.get(key);
  const year = (key) => state.years.get(key);
  const mapped = (courseKey, yearKey) => ({
    academic_year: year(yearKey),
    course: course(courseKey),
    mode: 'mapped_entries',
  });
  state.rules.push(
    ...(await createMany(target, 'course_enrollment_rules', [
      mapped('alpha', 'y1'),
      mapped('beta', 'y1'),
      mapped('beta', 'y2'),
      {
        academic_year: year('y1'),
        course: course('gamma'),
        mode: 'legacy_regex',
        pattern: lines.legacy,
      },
    ])),
  );
  const mapping = (key, courseKey, yearKey) => ({
    academic_year: year(yearKey),
    course: course(courseKey),
    entry: state.entries.get(lines[key]),
  });
  const ids = await createMany(target, 'moodle_course_mappings', [
    mapping('alpha71', 'alpha', 'y1'),
    mapping('beta71', 'beta', 'y1'),
    mapping('beta72', 'beta', 'y2'),
  ]);
  for (const [index, key] of ['alpha71', 'beta71', 'beta72'].entries()) {
    state.mappings.set(key, ids[index]);
  }
};

// Seeding sources is all it takes: the history index runs at the next
// tick, the counts at the one after, then the rules and mappings count.
const processesSeeds = async (t, target, state) => {
  await seedCatalog(target, state);
  const since = wallClock();
  const users = await createMany(target, 'moodle_users', seedUsers);
  state.users.push(...users);
  const edited = wallClock();
  const indexed = await waitForStatus(target, isCurrent('history_index'));
  record(
    t,
    state,
    latencyOf('history index after 4 new users', edited, indexed.report),
  );
  const counted = await settle(target);
  record(
    t,
    state,
    latencyOf('counts after that index', edited, counted.report),
  );
  assert.equal(await runsSince(target, historyFlowIds.refresh, since), 1);
  const entries = await get(
    target,
    '/items/moodle_course_entries?fields=id,label&limit=-1',
  );
  assert.deepEqual(
    entries.map(({ label }) => label).toSorted(byText),
    Object.values(lines).toSorted(byText),
  );
  for (const { id, label } of entries) state.entries.set(label, id);
  await seedRules(target, state);
  const mapped = wallClock();
  const done = await settle(target);
  record(
    t,
    state,
    latencyOf('counts after rules and mappings', mapped, done.report),
  );
  assert.deepEqual(await countsOf(target, state), expectedCounts);
};

// Moving a mapping to another course and year changes both pairs with no
// button pressed: the old pair loses its user, the new one gains it.
const followsMovedMapping = async (t, target, state) => {
  const since = wallClock();
  await patch(
    target,
    `/items/moodle_course_mappings/${state.mappings.get('beta72')}`,
    {
      academic_year: state.years.get('y1'),
      course: state.courses.get('alpha'),
    },
  );
  const edited = wallClock();
  const pending = await status(target);
  assert.equal(pending.domains.enrollments.current, false);
  const done = await settle(target);
  record(
    t,
    state,
    latencyOf('counts after moving a mapping', edited, done.report),
  );
  assert.deepEqual(await countsOf(target, state), {
    ...expectedCounts,
    'alpha/y1': 3,
    'beta/y2': 0,
  });
  assert.equal(await runsSince(target, dispatcherFlowId, since), 1);
  assert.equal(await runsSince(target, historyFlowIds.refresh, since), 0);
};

// Deleting a mapping leaves its rule, whose pair is then counted as zero.
const zeroesDeletedMapping = async (t, target, state) => {
  await remove(
    target,
    `/items/moodle_course_mappings/${state.mappings.get('beta71')}`,
  );
  state.mappings.delete('beta71');
  const edited = wallClock();
  const done = await settle(target);
  record(
    t,
    state,
    latencyOf('zero after deleting a mapping', edited, done.report),
  );
  assert.deepEqual(await countsOf(target, state), {
    ...expectedCounts,
    'alpha/y1': 3,
    'beta/y1': 0,
    'beta/y2': 0,
  });
};

// Fifty edits in parallel between two ticks: one claim, one run.
const coalescesBurst = async (t, target, state) => {
  await afterTick(1_500);
  const since = wallClock();
  const initial = await status(target);
  const before = initial.revisions.source;
  const ids = state.entries.values().toArray();
  const started = Date.now();
  await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      patch(target, `/items/moodle_course_entries/${ids[index % ids.length]}`, {
        review_reason: `Synthetic burst ${index}`,
      }),
    ),
  );
  const burstMs = Date.now() - started;
  const edited = wallClock();
  const edits = await status(target);
  assert.equal(edits.revisions.source, before + 50, 'one revision per edit');
  const done = await settle(target);
  record(
    t,
    state,
    latencyOf('counts after 50 parallel edits', edited, done.report),
  );
  t.diagnostic(`the 50 edits took ${burstMs} ms`);
  assert.equal(await runsSince(target, dispatcherFlowId, since), 1, 'one run');
  assert.equal(await runsSince(target, historyFlowIds.refresh, since), 0);
  assert.equal(done.report.revisions.completed, done.report.revisions.source);
};

test('refreshes derived data automatically on the native schedule', async (t) => {
  const target = targetFrom(process.env);
  const directus = adminRequest(target);
  const state = freshState();
  let resume = nothingToResume;
  await withDataModel(
    target,
    async () => {
      try {
        await t.test(
          'installs the templates once and settles a fresh project on its own',
          () => installsTemplates({ directus, state, t, target }),
        );
        await t.test('indexes and counts seeded sources without a button', () =>
          processesSeeds(t, target, state),
        );
        await t.test('follows a moved mapping on both of its pairs', () =>
          followsMovedMapping(t, target, state),
        );
        await t.test('counts zero for the pair of a deleted mapping', () =>
          zeroesDeletedMapping(t, target, state),
        );
        await t.test('coalesces a burst of fifty edits into one claim', () =>
          coalescesBurst(t, target, state),
        );
        await checksAfterSeeding(t, target, state);
      } finally {
        await t.test(
          'removes exactly what it created and restores the templates',
          async () => {
            try {
              await cleansUp(target, state);
            } finally {
              // No run may be mid-flight while the model is torn down.
              resume = await pauseAutomaticProcessing(target);
            }
          },
        );
      }
    },
    { automatic: true },
  );
  await resume();
  t.diagnostic(`latencies ${JSON.stringify(state.latencies)}`);
  await assertMarkerPresent(target);
  assert.deepEqual(await userCollections(target), [target.markerCollection]);
});
