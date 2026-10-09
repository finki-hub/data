import assert from 'node:assert/strict';
import { test } from 'node:test';

import { coordinationDomains } from '../../directus/extensions/directus-extension-data-operations/src/coordination/domains.js';
import { declaredFilenames } from '../../directus/extensions/directus-extension-data-operations/src/coordination/outcomes.js';
import { exportDefinitions } from '../../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { keySources } from '../../directus/extensions/directus-extension-data-operations/src/exports/key-sources.js';
import { readinessRegistry } from '../../directus/extensions/directus-extension-data-operations/src/exports/readiness-registry.js';
import {
  defaultPanels,
  operationsDashboardId,
} from '../../src/data-model/operations-dashboard.js';
import { markPendingFlowId } from '../../src/flows/mark-pending.js';
import { prepareAssetsFlowId } from '../../src/flows/prepare-public-assets.js';
import { publishAssetsFlowId } from '../../src/flows/publish-public-assets.js';
import { snapshotFlowId } from '../../src/flows/snapshot-import.js';
import { runSetup } from '../../src/setup.js';
import { assertMarkerPresent, targetFrom } from '../isolated-target.mjs';
import { createMany, settle } from './automatic-processing-helpers.mjs';
import {
  adminRequest,
  assertNoAccessResidue,
  userCollections,
  withDataModel,
  withRestrictedUser,
} from './data-model-helpers.mjs';
import { engineFiles, restReader } from './export-projection-helpers.mjs';
import { get, patch, post, remove } from './history-index-helpers.mjs';
import { callAs, codeOf, keysDeep, runFlow } from './operations-helpers.mjs';

// The Data operations dashboard on a live project (Task 16): setup
// installs the dashboard and its default panels once; the status read
// answers a bounded view, and the caller check refuses it and the
// migrations endpoint without a signed-in user (401) or the admin flag
// (403); the trigger endpoint refuses a run to a caller who cannot read
// data_operations; every course is counted in a new year at the next
// tick, without any row added for the year, and the year is public only
// once published. The schedule stays active. Every row, user and role is
// synthetic and removed.

const courseCount = 260;
const line = 'Synthetic Operations Line';
const unmappedLine = 'Synthetic Operations Unmapped Line';
const newYear = '2093/2094';
const oldYear = '2092/2093';
const runFlows = [publishAssetsFlowId, markPendingFlowId, snapshotFlowId];
const forbiddenPayload = ['token', 'owner', 'fingerprint', 'process'];

const bookmarkPattern = /bookmark=(?<id>\d+)$/u;

// A request of the given caller, as { status, body }.
const as = (target, token) => (method, path, body) =>
  callAs(target, token, { body, method, path });

// A run of a manual Flow by the given caller.
const flowAs = (target, token) => (id, values) =>
  runFlow(target, token, { id, values });

const installsOnce = async ({ directus, t, target }) => {
  const summary = await runSetup(directus);
  assert.deepEqual(summary.dashboard.created, [
    'Data operations',
    ...defaultPanels.map(({ name }) => name),
  ]);
  const panels = await get(
    target,
    `/panels?fields=id,type,options,name&limit=-1&filter[dashboard][_eq]=${operationsDashboardId}`,
  );
  assert.deepEqual(
    panels.map(({ id, type }) => `${id} ${type}`).toSorted(),
    defaultPanels.map(({ id, type }) => `${id} ${type}`).toSorted(),
  );
  const again = await runSetup(directus);
  assert.deepEqual(again.dashboard.created, []);
  t.diagnostic(`dashboard: ${panels.length} panels`);
};

// A Studio edit of a default panel survives a rerun, a deleted one comes
// back.
const keepsEdits = async ({ directus, target }) => {
  const [first, second] = defaultPanels;
  await patch(target, `/panels/${first.id}`, { name: 'Publish (edited)' });
  await remove(target, `/panels/${second.id}`);
  const rerun = await runSetup(directus);
  assert.deepEqual(rerun.dashboard.created, [second.name]);
  const [edited] = await get(
    target,
    `/panels?fields=name&filter[id][_eq]=${first.id}`,
  );
  assert.equal(edited.name, 'Publish (edited)');
};

// 260 courses, All professors so that courses.json needs no staff link,
// an older published year, a new unpublished year, one Moodle user with
// two history lines and a mapping of one line to the first course in the
// new year, and an equivalency without a course (a warning with a Needs
// review bookmark).
const seedRows = async (target) => {
  const courses = await createMany(
    target,
    'courses',
    Array.from({ length: courseCount }, (_, index) => ({
      name: `Synthetic Operations Course ${String(index + 1).padStart(3, '0')}`,
      pattern_mappings: [],
      status: 'all_professors',
    })),
  );
  const [older, newer] = await createMany(target, 'academic_years', [
    { label: oldYear, published: true, sort: 92 },
    { label: newYear, published: false, sort: 93 },
  ]);
  await post(target, '/items/moodle_users', {
    Courses: [line, unmappedLine].join('\n'),
    'Courses Count': 2,
    Name: 'Synthetic Operations User',
  });
  await post(target, '/items/course_equivalencies', { course: null });
  await settle(target);
  // The index run created the line, so it records its First seen.
  const [entry] = await get(
    target,
    `/items/moodle_course_entries?fields=id,first_seen&filter[label][_eq]=${encodeURIComponent(line)}`,
  );
  assert.equal(typeof entry.first_seen, 'string');
  await post(target, '/items/moodle_course_mappings', {
    academic_year: newer,
    course: courses[0],
    entry: entry.id,
  });
  return { courses, newYear: newer, oldYear: older };
};

// The review link of a positive check opens its bookmark, and the
// fixture token reads the records behind it.
const navigatesToIssues = async ({ t, target }) => {
  const request = as(target, target.token);
  const readiness = await request('GET', '/finki-hub-data-status/readiness');
  assert.equal(readiness.status, 200);
  const positive = readiness.body.data.checks.find(
    ({ code }) => code === 'equivalency_without_course',
  );
  assert.ok(positive.count > 0);
  const bookmark = bookmarkPattern.exec(positive.link)?.groups?.id;
  assert.ok(bookmark !== undefined, positive.link);
  const preset = await request('GET', `/presets/${bookmark}`);
  assert.equal(preset.status, 200);
  assert.equal(preset.body.data.bookmark, positive.review);
  const filter = encodeURIComponent(JSON.stringify(preset.body.data.filter));
  const rows = await request(
    'GET',
    `/items/${positive.page}?fields=id,course&filter=${filter}`,
  );
  assert.equal(rows.status, 200);
  assert.ok(rows.body.data.length >= positive.count);
  t.diagnostic(
    `followed ${positive.link} to ${rows.body.data.length} record(s)`,
  );
};

// The caller check: 401 UNAUTHENTICATED without a signed-in user and
// 403 FORBIDDEN without the admin flag, on the status read and the
// migrations endpoint alike; the trigger endpoint refuses both a run, and
// the plain user reads no data_operations row.
const refusesStrangers = async (target, plain) => {
  for (const token of [null, plain]) {
    const request = as(target, token);
    const [expected, code, message] =
      token === null
        ? [401, 'UNAUTHENTICATED', 'Authentication required']
        : [403, 'FORBIDDEN', 'Forbidden'];
    for (const [method, path] of [
      ['GET', '/finki-hub-data-status'],
      ['GET', '/finki-hub-data-status/readiness'],
      ['POST', '/finki-hub-data-operations/migrations/schema-constraints'],
      ['GET', '/finki-hub-data-operations/status'],
    ]) {
      const answer = await request(method, path);
      assert.equal(
        answer.status,
        expected,
        `${method} ${path}: ${JSON.stringify(answer.body)}`,
      );
      assert.equal(codeOf(answer), code);
      assert.equal(answer.body.errors[0].message, message);
    }
    for (const id of runFlows) {
      const run = await flowAs(target, token)(id);
      assert.equal(run.status, 403, JSON.stringify(run.body));
    }
  }
  const operations = await as(target, plain)('GET', '/items/data_operations');
  assert.equal(operations.status, 403, JSON.stringify(operations.body));
};

const guardsAccess = async ({ target }) => {
  await withRestrictedUser(target, (plain) => refusesStrangers(target, plain));
  await assertNoAccessResidue(target);
};

// The rows of courses.json that carry the new year as a key.
const keyedRows = async (target) => {
  const files = await engineFiles(exportDefinitions, restReader(target));
  const courses = files.find(({ filename }) => filename === 'courses.json');
  return JSON.parse(courses.body).filter((row) => Object.hasOwn(row, newYear))
    .length;
};

// After one tick every new pair has a count (zero where nothing is
// mapped); the year is public only once published.
const countsAndPublishes = async ({ state, t, target }) => {
  await settle(target);
  const counts = await get(
    target,
    `/items/course_enrollments?fields=course,count&limit=-1&filter[academic_year][_eq]=${state.newYear}`,
  );
  const [mappedCourse] = state.courses;
  assert.equal(counts.length, state.courses.length);
  assert.equal(counts.find(({ course }) => course === mappedCourse)?.count, 1);
  assert.equal(
    counts.filter((row) => row.count === 0).length,
    state.courses.length - 1,
  );
  assert.equal(await keyedRows(target), 0, 'an unpublished year places no key');
  await patch(target, `/items/academic_years/${state.newYear}`, {
    published: true,
  });
  await settle(target);
  assert.equal(await keyedRows(target), state.courses.length);
  const prepared = await flowAs(target, target.token)(prepareAssetsFlowId);
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  t.diagnostic(
    `counts: ${counts.length} rows, ${counts.length - 1} zeros; the published year keys ${state.courses.length} courses`,
  );
};

// The status view: lists from the declarations, and no token, owner,
// fingerprint, process or Moodle user record.
const showsLists = async ({ state, target }) => {
  const request = as(target, target.token);
  const view = await request('GET', '/finki-hub-data-status');
  assert.equal(view.status, 200);
  const { data } = view.body;
  const keys = keysDeep(data).map((key) => key.toLowerCase());
  for (const word of forbiddenPayload) {
    assert.ok(
      keys.every((key) => !key.includes(word)),
      word,
    );
  }
  assert.ok(!JSON.stringify(view.body).includes('Synthetic Operations User'));
  assert.deepEqual(
    data.domains.map(({ name }) => name),
    coordinationDomains,
  );
  assert.deepEqual(
    data.publication.files.map(({ filename }) => filename),
    declaredFilenames,
  );
  assert.deepEqual(
    data.keySources.map(({ name }) => name),
    Object.keys(keySources),
  );
  const years = data.keySources.find(
    ({ collection }) => collection === 'academic_years',
  );
  assert.deepEqual(
    years.rows
      .filter(({ id }) => [state.newYear, state.oldYear].includes(id))
      .map(({ key, placesKeys }) => [key, placesKeys]),
    [
      [newYear, true],
      [oldYear, true],
    ],
  );
  assert.ok(
    data.schedule.some(
      ({ lastRunAt, name }) =>
        name === 'Data / Process pending' && lastRunAt !== null,
    ),
  );
  const readiness = await request('GET', '/finki-hub-data-status/readiness');
  assert.deepEqual(
    readiness.body.data.checks.map(({ code }) => code),
    readinessRegistry.map(({ code }) => code),
  );
};

const seeds = async ({ state, target }) => {
  Object.assign(state, await seedRows(target));
};

test('installs the Data operations dashboard and guards every data operation', async (t) => {
  const target = targetFrom(process.env);
  const directus = adminRequest(target);
  const state = { courses: [] };

  await withDataModel(
    target,
    async () => {
      const context = { directus, state, t, target };
      await t.test('installs the dashboard and its panels once', () =>
        installsOnce(context),
      );
      await t.test('keeps Studio edits of the dashboard', () =>
        keepsEdits(context),
      );
      await t.test('seeds courses, years and one mapped history line', () =>
        seeds(context),
      );
      await t.test(
        'follows the review link of a positive check to its bookmark and records',
        () => navigatesToIssues(context),
      );
      await t.test(
        'refuses the status read, the migrations endpoint and every run to a refused caller',
        () => guardsAccess(context),
      );
      await t.test(
        'counts every course in the new year at the next tick and publishes the year only once opted in',
        () => countsAndPublishes(context),
      );
      await t.test(
        'lists the domains, files, key sources and checks from their declarations',
        () => showsLists(context),
      );
    },
    { automatic: true },
  );

  await assertMarkerPresent(target);
  assert.deepEqual(await userCollections(target), [target.markerCollection]);
  assert.deepEqual(
    await get(target, `/dashboards?filter[id][_eq]=${operationsDashboardId}`),
    [],
  );
});
