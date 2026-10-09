import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';

import { historyId } from '../../src/flows/flow-template.js';
import { markPendingFlowId } from '../../src/flows/mark-pending.js';
import { runSetup } from '../../src/setup.js';
import {
  createRows,
  entryIds,
  seedMappings,
  seedReference,
  snapshotFor,
} from '../fixture-seed.mjs';
import { declarations } from '../fixtures/stress-fixture.js';
import { indexOf } from '../fixtures/stress-snapshot.js';
import { isolatedTargets } from '../isolated-target.mjs';
import {
  assertCounts,
  importsSnapshot,
  publishes,
  publishPreconditions,
  removeRunFiles,
  snapshotFiles,
  uploadSnapshot,
} from '../publish-workflow-helpers.mjs';
import { stagedOrOver, watchesInstall } from '../publish-workflow-races.mjs';
import { psql, waitForStatus } from './automatic-processing-helpers.mjs';
import {
  adminRequest,
  errorCode,
  userCollections,
  withDataModel,
} from './data-model-helpers.mjs';
import { readiness } from './export-projection-helpers.mjs';
import {
  count,
  get,
  patch,
  rebuild,
  remove,
  status,
} from './history-index-helpers.mjs';
import {
  installHistoryRunner,
  removeHistoryRunner,
} from './history-runner.mjs';
import { runFlow } from './operations-helpers.mjs';
import {
  cgroupOf,
  lastRunMs,
  measured,
  setSchedule,
  watchImportState,
} from './stress-helpers.mjs';

// `npm run test:relational -- --scenario stress` (opt-in, never part of
// the default suite): the generated full-size run. 30,000 Moodle users
// with 5,000 distinct history labels, the model's academic years plus one
// newer unpublished year, the generations and programs the import seeds,
// 400 courses with their default pattern mapping, and the published
// files of the export registry, all written through the REST API; then
// the unchanged CSV through staging and promotion, the history index and
// the enrollment counts on the native schedule (before and after the new
// year's lines get explicit mappings), readiness and a manual publication
// to the local S3 bucket. Each phase records its wall time and the memory of the
// Directus and database containers (stress-helpers.mjs); counts, ids and
// index are checked against the oracle through the API, never printed.
// Follow-up 24 (the refresh Flow's refused-completion branch) and
// follow-up 11 (parent deletes while a count run installs) run on the way.

const size = { courses: 400, labels: 5_000, referenceRows: 300, users: 30_000 };
const longRun = 45 * 60_000;
const splitScriptId = historyId('22');
const probeComment = '\n// synthetic stress probe: a graph edit during the run';

const waitUntil = (target, predicate, pollMs = 1_000) =>
  waitForStatus(target, predicate, { limitMs: longRun, pollMs });

const idle = (report) => report.claim === null;
const current = (domain) => (report) =>
  idle(report) && report.domains[domain].current;

// Waits until the domain's run is over, polling every two seconds, and
// records the most pages a claim of the domain planned meanwhile.
const waitCounting = async (target, domain) => {
  let pages = null;
  const done = await waitUntil(
    target,
    (report) => {
      if (report.claim?.domain === domain && report.claim.pages !== null) {
        pages = Math.max(pages ?? 0, report.claim.pages);
      }
      return current(domain)(report);
    },
    2_000,
  );
  return { ...done, pages };
};

const setsUp = (context) =>
  measured(context, 'setup', async () => {
    await runSetup(context.directus);
  });

const seeds = (context) =>
  measured(context, 'seed reference rows (REST)', async () => {
    const { state, target } = context;
    const seeded = await seedReference(target, declarations, size);
    // Three courses a count run's install will meet deleted (follow-up 11).
    const doomed = await createRows(
      target,
      'courses',
      [1, 2, 3].map((index) => ({
        name: `Synthetic Doomed Course ${index}`,
        pattern_mappings: [],
      })),
    );
    Object.assign(state, {
      doomed,
      mappings: [],
      patterns: seeded.patterns,
      seeded,
    });
    context.t.diagnostic(
      `seeded ${seeded.courses.length} courses, ${seeded.years.length} years, ${seeded.generations.length} generations, ${seeded.programs.length} programs, ${seeded.curriculum.entries.length} entries, ${seeded.curriculum.states} states, ${seeded.assignments.length} assignments, ${seeded.patterns.length} pattern mappings`,
    );
  });

const generates = (context) =>
  measured(context, 'generate and upload the CSV (test process)', async () => {
    const { state } = context;
    const started = performance.now();
    Object.assign(state, {
      snapshotRows: snapshotFor(declarations, state.seeded, size),
    });
    const generatedMs = Math.round(performance.now() - started);
    const snapshotFile = await uploadSnapshot(context, { name: 'stress' });
    Object.assign(state, { snapshotFile });
    context.t.diagnostic(`generated ${size.users} rows in ${generatedMs} ms`);
  });

// The ids of both instances, exactly the generated ones.
const assertInstanceIds = async ({ declarations: declared, state, target }) => {
  const [oldField, newField] = declared.snapshot.instanceIds;
  const users = await get(
    target,
    `/items/moodle_users?fields=${encodeURIComponent(oldField)},${encodeURIComponent(newField)}&limit=-1`,
  );
  for (const field of [oldField, newField]) {
    const position = declared.snapshot.fields.indexOf(field);
    const generated = state.snapshotRows.rows
      .map((row) => row[position])
      .filter((id) => id !== null)
      .toSorted((left, right) => left - right);
    const stored = users
      .map((user) => user[field])
      .filter((id) => id !== null)
      .toSorted((left, right) => left - right);
    assert.equal(stored.length, generated.length, field);
    assert.ok(
      stored.every((id, index) => id === generated[index]),
      `${field}: the stored ids differ from the generated ones`,
    );
  }
};

const imports = (context) =>
  measured(context, 'import: staging and promotion', async () => {
    const { state, t, target } = context;
    const watcher = watchImportState(target);
    let answer;
    try {
      answer = await importsSnapshot(context, state.snapshotFile);
    } finally {
      Object.assign(state, { importStates: await watcher.stop() });
    }
    await assertInstanceIds(context);
    t.diagnostic(
      `imported ${answer.rows} rows; import states first seen (ms): ${JSON.stringify(state.importStates)}`,
    );
  });

// Follow-up 24: the synthetic history runner (history-runner.mjs) claims
// history_index and runs the installed "Data / Refresh history index", the
// Flow the schedule runs; a Studio edit of the history page Script while
// it holds the claim lets the pages finish, the coordinator refuses the
// completion (FINGERPRINT_CHANGED, released at once, not blocking) and the
// refresh Flow's refused-completion branch answers the completion's own
// code, which the runner raises (only that branch answers it; every other
// branch answers INDEX_FAILED). The domain stays pending.
const refusesHistoryCompletion = (context) =>
  measured(context, 'history index: run refused at completion', async () => {
    const { state, t, target } = context;
    const [script] = await get(
      target,
      `/operations?fields=options&filter[id][_eq]=${splitScriptId}`,
    );
    Object.assign(state, { splitScript: script.options });
    // The runner claims, not the schedule.
    await setSchedule(target, false);
    await installHistoryRunner(target);
    let run;
    try {
      const answer = rebuild(target);
      await waitUntil(
        target,
        (claimed) => claimed.claim?.domain === 'history_index',
        250,
      );
      await patch(target, `/operations/${splitScriptId}`, {
        options: {
          ...script.options,
          code: `${script.options.code}${probeComment}`,
        },
      });
      run = await answer;
    } finally {
      await patch(target, `/operations/${splitScriptId}`, {
        options: script.options,
      });
      await removeHistoryRunner(target);
    }
    assert.equal(run.status, 500, JSON.stringify(run.body));
    assert.equal(errorCode(run.body), 'COORDINATION_FINGERPRINT_CHANGED');
    const report = await status(target);
    assert.equal(report.claim, null);
    assert.equal(report.lastError?.code, 'FINGERPRINT_CHANGED');
    assert.equal(report.lastError?.domain, 'history_index');
    assert.equal(report.lastError?.blocking, false);
    assert.equal(report.domains.history_index.current, false);
    Object.assign(state, {
      followUp24: {
        coordinator: report.lastError.code,
        refreshAnswer: errorCode(run.body),
      },
    });
    t.diagnostic(
      `refused history completion: the refresh Flow answered ${errorCode(run.body)} (${run.body.errors[0].message.slice(0, 160)}); status ${report.lastError.code}, not blocking, history_index pending`,
    );
  });

const indexes = (context) =>
  measured(context, 'history index: full run', async () => {
    const { state, t, target } = context;
    await setSchedule(target, true);
    const done = await waitUntil(target, current('history_index'));
    const runMs = lastRunMs(done.report);
    const index = indexOf(state.snapshotRows.lines);
    assert.equal(
      await count(target, 'moodle_history_memberships'),
      index.memberships,
    );
    const entries = await entryIds(target);
    assert.equal(entries.size, size.labels);
    assert.ok([...index.labels].every((label) => entries.has(label)));
    t.diagnostic(
      `history run ${runMs} ms: ${entries.size} entries, ${index.memberships} memberships`,
    );
  });

// The course-years every run counts: every created course (the doomed
// ones included) in every year.
const pairsOf = ({ doomed, seeded }) =>
  (seeded.courses.length + doomed.length) * seeded.years.length;

const countsPatterns = (context) =>
  measured(context, 'enrollment counts: pattern mappings', async () => {
    const { state, t, target } = context;
    const done = await waitCounting(target, 'enrollments');
    await setSchedule(target, false);
    await assertCounts(context, 'pattern mappings');
    t.diagnostic(
      `enrollments run ${lastRunMs(done.report)} ms over ${pairsOf(state)} course-years; the claim planned ${done.pages} pages`,
    );
  });

const mapsYear = (context) =>
  measured(context, 'explicit mappings of the new year', async () => {
    const { state, t, target } = context;
    const position = state.seeded.years.findIndex(
      ({ published }) => !published,
    );
    const started = performance.now();
    const mappings = await seedMappings(target, {
      labels: state.snapshotRows.labels,
      seeded: state.seeded,
      year: position,
    });
    const mappingMs = Math.round(performance.now() - started);
    Object.assign(state, { mappings });
    t.diagnostic(`${mappings.length} explicit mappings in ${mappingMs} ms`);
  });

const countsWithExplicit = (context) =>
  measured(context, 'enrollment counts: with explicit mappings', async () => {
    const { state, t, target } = context;
    await setSchedule(target, true);
    const done = await waitCounting(target, 'enrollments');
    await assertCounts(context, 'with explicit mappings');
    t.diagnostic(
      `enrollments run ${lastRunMs(done.report)} ms over ${pairsOf(state)} course-years (with ${state.mappings.length} explicit mappings); the claim planned ${done.pages} pages`,
    );
  });

const deadlocks = async ({ containers }) => {
  const [[value = '0'] = []] = await psql(
    "SELECT deadlocks FROM pg_stat_database WHERE datname = 'directus'",
    containers.database,
  );
  return Number(value);
};

// Follow-up 11: the three doomed courses are deleted (cascading into
// course_enrollments) the moment a count run has staged every page; the
// run must be caught installing (a full-size install lasts seconds).
const deletesDuringInstall = (context) =>
  measured(
    context,
    'enrollment counts: parent deletes at install',
    async () => {
      const { state, t, target } = context;
      const before = await deadlocks(context);
      const marked = await runFlow(target, target.token, {
        id: markPendingFlowId,
        values: { domains: ['enrollments'] },
      });
      assert.equal(marked.status, 200, JSON.stringify(marked.body));
      const staged = await waitUntil(target, stagedOrOver, 250);
      assert.notEqual(
        staged.report.claim,
        null,
        'the deletes met the run with every page staged',
      );
      const deleteMs = await Promise.all(
        state.doomed.map(async (course) => {
          const started = performance.now();
          await remove(target, `/items/courses/${course}`);
          return Math.round(performance.now() - started);
        }),
      );
      const { install, report: settled } = await watchesInstall(target, {
        before: staged.report,
        until: current('enrollments'),
        wait: { limitMs: longRun, pollMs: 250 },
      });
      await setSchedule(target, false);
      await assertCounts(context, 'after the parent deletes');
      const left = await get(
        target,
        `/items/course_enrollments?aggregate[count]=*&filter[course][_in]=${state.doomed.join(',')}`,
      );
      assert.equal(Number(left[0]?.count ?? 0), 0);
      Object.assign(state, {
        followUp11: {
          deadlocks: (await deadlocks(context)) - before,
          deleteMs,
          install,
          lastError: settled.lastError?.code ?? null,
          pages: staged.report.claim.pages,
        },
      });
      t.diagnostic(
        `parent deletes with all ${staged.report.claim.pages} pages staged: ${JSON.stringify(state.followUp11)}`,
      );
    },
  );

const checksReadiness = (context) =>
  measured(context, 'readiness', async () => {
    const answer = await readiness(context.target);
    assert.equal(answer.ready, true, JSON.stringify(answer.blockers));
  });

const publishesAll = (context) =>
  measured(context, 'publication', async () => {
    const run = await publishes(context);
    const report = await status(context.target);
    assert.equal(report.publication.state, 'completed');
    context.t.diagnostic(
      `published revision ${run.revision}: ${Object.values(
        report.publication.files,
      )
        .map(({ bytes }) => bytes)
        .join(', ')} bytes`,
    );
  });

const steps = [
  ['sets up the project', setsUp],
  ['writes the generated full-size reference rows', seeds],
  ['generates and uploads the full-size CSV', generates],
  ['imports it through staging and promotion', imports],
  [
    'refuses a history completion after a graph edit during the run (follow-up 24)',
    refusesHistoryCompletion,
  ],
  ['indexes every history on the schedule', indexes],
  ['counts every course and year through the dispatcher', countsPatterns],
  ['maps the lines of the new year by hand', mapsYear],
  ['counts again with the explicit mappings', countsWithExplicit],
  [
    'keeps counts consistent when parents are deleted at install (follow-up 11)',
    deletesDuringInstall,
  ],
  ['passes readiness', checksReadiness],
  ['publishes every declared file', publishesAll],
];

const cleansUp = async (context) => {
  const { state, target } = context;
  await setSchedule(target, false);
  await removeHistoryRunner(target);
  if (state.splitScript !== undefined) {
    await patch(target, `/operations/${splitScriptId}`, {
      options: state.splitScript,
    });
  }
  await removeRunFiles(context);
};

test('measures the generated full-size workflow', async (t) => {
  const { containers, s3, target } = await isolatedTargets(process.env, {
    containers: ['directus', 'database'],
    s3: 'required',
  });
  const { keysBefore } = await publishPreconditions(target, s3);
  const phases = [];
  const context = {
    cgroups: {
      database: await cgroupOf(containers.database),
      directus: await cgroupOf(containers.directus),
    },
    containers,
    declarations,
    directus: adminRequest(target),
    phases,
    s3,
    state: {
      dir: await mkdtemp(path.join(os.tmpdir(), 'stress-')),
      files: [],
      filesBefore: new Set(await snapshotFiles(target)),
      keysBefore,
    },
    t,
    target,
  };
  await withDataModel(target, async () => {
    try {
      for (const [name, step] of steps) {
        await t.test(name, () => step(context));
      }
    } finally {
      await t.test('removes the objects and files it created', () =>
        cleansUp(context),
      );
    }
  });
  t.diagnostic(`phases ${JSON.stringify(phases)}`);
  t.diagnostic(
    `follow-ups ${JSON.stringify({ 11: context.state.followUp11, 24: context.state.followUp24 })}`,
  );
  assert.deepEqual(await userCollections(target), [target.markerCollection]);
});
