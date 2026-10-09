import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  defaultPattern,
  defaultYearPattern,
} from '../../directus/extensions/directus-extension-data-operations/src/enrollment-lines.js';
import { dataModelCollectionKeys } from '../../src/data-model/collections.js';
import {
  applySchemaConstraints,
  applySourceInvalidation,
} from '../../src/data-model/constraints.js';
import { installDataModel } from '../../src/data-model/install.js';
import { dispatcherFlow } from '../../src/flows/count-enrollments.js';
import { flowFamilyCodes } from '../../src/flows/flow-template.js';
import { historyIndexFlows } from '../../src/flows/index-histories.js';
import { installFlowTemplates } from '../../src/flows/install-flows.js';
import {
  matchFailureCode,
  matchFlow,
  matchingFlows,
} from '../../src/flows/match-history-lines.js';
import { installFlowFamily } from '../../src/flows/registry.js';
import { assertMarkerPresent, targetFrom } from '../isolated-target.mjs';
import {
  anonymousTrigger,
  countedLinesPath,
  drive,
  driverFlowId,
  enrollmentCounts,
  firstCounts,
  installDriverFlow,
  installedFromDatabase,
  matchesPath,
  patternMappingsPath,
  removeAll,
  resolvedFromDatabase,
  seedExplicit,
  seedMappings,
  seedUsers,
  seedYears,
} from './counting-helpers.mjs';
import {
  adminRequest,
  errorCode,
  json,
  request,
  userCollections,
  withDataModel,
} from './data-model-helpers.mjs';
import {
  act,
  flowId as coordinateFlowId,
  count,
  create,
  entriesByLabel,
  entriesPath,
  get,
  historyRunnerId,
  installSyntheticFlow,
  patch,
  rebuild,
  refused,
  remove,
  status,
} from './history-index-helpers.mjs';
import { installHistoryRunner } from './history-runner.mjs';

// The enrollment counts on a real database: "Data / Count enrollments"
// plans the history lines, "Data / Match history lines" stages each page's
// matches, and the completion's SQL rebuilds the counted lines and every
// count row. The SQL must count exactly what resolveLines and countPairs
// count over the same rows (enrollment-lines.ts). A course created over
// the API gets its default pattern mapping in the same transaction.

const byKey = (left, right) => left.key.localeCompare(right.key);
const capRefusal = /Page p0001: matches \d+, max 10000$/u;
const capMappings = 84;
const capLines = 120;

// Claims enrollments and runs the installed dispatcher under the claim,
// as the schedule does.
const countRun = async (target) => {
  const claim = await act(target, {
    action: 'claim',
    domain: 'enrollments',
    retry: null,
  });
  assert.equal(claim.claimed, true, JSON.stringify(claim));
  return drive(target, dispatcherFlow.id, {
    claim: claim.token,
    revision: claim.revision,
  });
};

// The SQL completion against the TypeScript rules over the same rows.
const assertEqualToResolver = async (target) => {
  const installed = await installedFromDatabase(target);
  const resolved = await resolvedFromDatabase(target);
  assert.deepEqual(installed.counted, resolved.counted);
  assert.deepEqual(installed.counts, resolved.counts);
};

// The matching family and the dispatcher are installed once, live exactly
// as defined; the schedule is not installed, so the suite runs the
// dispatcher itself. The coordinator probe, the driver and the history
// runner join them for this run only.
const installsFlows = async (target, directus, state) => {
  const listed = await get(target, '/flows?fields=id&limit=-1');
  const present = new Set(listed.map(({ id }) => id));
  state.templatesCreated = [
    ...historyIndexFlows,
    ...matchingFlows,
    dispatcherFlow,
  ]
    .map(({ id }) => id)
    .filter((id) => !present.has(id));
  await installFlowFamily(directus, flowFamilyCodes.history);
  await installFlowFamily(directus, flowFamilyCodes.matching);
  await installFlowTemplates(directus, [dispatcherFlow]);
  for (const flow of [matchFlow, dispatcherFlow]) {
    const operations = await get(
      target,
      `/operations?fields=key,name,type,options,resolve,reject&filter[flow][_eq]=${flow.id}&limit=-1`,
    );
    assert.deepEqual(
      operations.toSorted(byKey),
      flow.operations
        .map(({ key, name, options, reject, resolve, type }) => ({
          key,
          name,
          options,
          reject,
          resolve,
          type,
        }))
        .toSorted(byKey),
    );
  }
  state.flows.push(coordinateFlowId);
  await installSyntheticFlow(target);
  state.flows.push(driverFlowId);
  await installDriverFlow(target);
  state.flows.push(historyRunnerId);
  await installHistoryRunner(target);
};

// Users are indexed first (the history index is upstream of the counts),
// then the courses, years, pattern mappings and explicit mappings follow.
const seeds = async (target, state) => {
  for (const [key, courses] of seedUsers) {
    state.ids.set(
      key,
      await create(target, state, [
        'moodle_users',
        { Courses: courses, Name: `Synthetic Counting User ${key}` },
      ]),
    );
  }
  const run = await rebuild(target);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.completed, true);
  for (const key of ['a', 'b', 'c']) {
    const id = await create(target, state, [
      'courses',
      {
        name: `Synthetic Counting Course ${key.toUpperCase()}`,
        pattern_mappings: [],
      },
    ]);
    state.ids.set(key, id);
    state.courses.set(id, key);
  }
  for (const [key, label, sort] of seedYears) {
    const id = await create(target, state, ['academic_years', { label, sort }]);
    state.ids.set(key, id);
    state.years.set(id, key);
  }
  // A course created with an empty list gets no default mapping.
  assert.equal(await count(target, 'moodle_pattern_mappings'), 0);
  for (const [course, pattern, year] of seedMappings) {
    await create(target, state, [
      'moodle_pattern_mappings',
      {
        course: state.ids.get(course),
        pattern,
        ...(year.only_in_year === undefined
          ? { year_pattern: year.year_pattern }
          : { only_in_year: state.ids.get(year.only_in_year) }),
      },
    ]);
  }
  const entries = await entriesByLabel(target);
  for (const [label, course, year] of seedExplicit) {
    await create(target, state, [
      'moodle_course_mappings',
      {
        academic_year: state.ids.get(year),
        course: state.ids.get(course),
        entry: entries.get(label).id,
      },
    ]);
  }
  const report = await status(target);
  assert.deepEqual(report.pending, ['enrollments', 'publication']);
};

// One run: every page matched, the counted lines and a row for every
// course and year installed, equal to resolveLines and countPairs.
const countsByThePrecedenceRules = async (target, state) => {
  const answer = await countRun(target);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.completed, true);
  assert.equal(answer.pages, 1);
  assert.equal(answer.installed, 9);
  assert.deepEqual(await enrollmentCounts(target, state), firstCounts);
  await assertEqualToResolver(target);
  assert.equal(await count(target, 'data_operation_matches'), 0);
  const counted = await get(
    target,
    `${countedLinesPath}?fields=source,entry.label&filter[source][_eq]=explicit&limit=-1`,
  );
  assert.deepEqual(counted, [
    { entry: { label: seedExplicit[0][0] }, source: 'explicit' },
  ]);
  const report = await status(target);
  assert.deepEqual(report.pending, ['publication']);
};

// A course created over the API gets its default mapping in the same
// transaction, its line counts at the next run, a refused create leaves
// no mapping, and a renamed course keeps its mapping.
const createsTheDefaultMapping = async (target, state) => {
  const name = 'Counting Delta';
  const id = await create(target, state, ['courses', { name }]);
  state.ids.set('d', id);
  state.courses.set(id, 'd');
  const mappingsOfD = () =>
    get(
      target,
      `${patternMappingsPath}?fields=pattern,year_pattern,only_in_year&filter[course][_eq]=${id}&limit=-1`,
    );
  assert.deepEqual(await mappingsOfD(), [
    {
      only_in_year: null,
      pattern: defaultPattern(name),
      year_pattern: defaultYearPattern,
    },
  ]);

  const before = await count(target, 'moodle_pattern_mappings');
  const refusedCreate = await request(
    target,
    '/items/courses',
    json('POST', { name: 'Counting Refused', status: 'retired' }, target.token),
  );
  const refusedBody = await refusedCreate.json();
  assert.equal(refusedCreate.status, 400, JSON.stringify(refusedBody));
  assert.ok(errorCode(refusedBody) !== null);
  assert.equal(await count(target, 'moodle_pattern_mappings'), before);

  await countRun(target);
  const counted = await enrollmentCounts(target, state);
  assert.equal(counted['d/y2'], 1);

  await patch(target, `/items/courses/${id}`, { name: 'Counting Delta New' });
  assert.deepEqual(await mappingsOfD(), [
    {
      only_in_year: null,
      pattern: defaultPattern(name),
      year_pattern: defaultYearPattern,
    },
  ]);
  await countRun(target);
  const renamed = await enrollmentCounts(target, state);
  assert.equal(renamed['d/y2'], 1);
  await assertEqualToResolver(target);
};

// More than 10,000 matches on one page fail the run: the page fails the
// claim with MATCH_FAILED, nothing is installed, and the counts stay.
const refusesAPageOverTheRowCap = async (target, state) => {
  const lines = Array.from(
    { length: capLines },
    (_, index) => `Counting Cap ${String(index).padStart(3, '0')}`,
  );
  await create(target, state, [
    'moodle_users',
    { Courses: lines.join('\n'), Name: 'Synthetic Counting Cap User' },
  ]);
  const indexed = await rebuild(target);
  assert.equal(indexed.status, 200, JSON.stringify(indexed.body));
  const created = await request(
    target,
    patternMappingsPath,
    json(
      'POST',
      Array.from({ length: capMappings }, (_, index) => ({
        course: state.ids.get('c'),
        only_in_year: state.ids.get('y1'),
        pattern: `^Counting Cap(?:${String(index)})?`,
      })),
      target.token,
    ),
  );
  const body = await created.json();
  assert.equal(created.status, 200, JSON.stringify(body));
  const capIds = body.data.map(({ id }) => id);
  const counts = await enrollmentCounts(target, state);

  const answer = await countRun(target);
  assert.equal(answer.ok, false, JSON.stringify(answer));
  assert.equal(answer.stage, 'check');
  assert.match(answer.message, capRefusal);
  const report = await status(target);
  assert.equal(report.lastError.code, matchFailureCode);
  assert.match(report.lastError.message, capRefusal);
  assert.deepEqual(await enrollmentCounts(target, state), counts);
  assert.equal(await count(target, 'data_operation_matches'), 0);

  await removeAll(target, patternMappingsPath, capIds);
  await countRun(target);
  await assertEqualToResolver(target);
};

// Deleting a pattern mapping removes its counted lines and the matches a
// running claim staged for it, through the write guards (a cascade); the
// running claim is then overtaken.
const cascadesThroughTheGuards = async (target, state) => {
  const [alpha] = await get(
    target,
    `${patternMappingsPath}?fields=id&filter[pattern][_eq]=${encodeURIComponent(seedMappings[0][1])}&limit=1`,
  );
  const entries = await entriesByLabel(target);
  // The counts are current: a mark makes them claimable again.
  await act(target, { action: 'mark', domains: ['enrollments'] });
  const claim = await act(target, {
    action: 'claim',
    domain: 'enrollments',
    retry: null,
  });
  assert.equal(claim.claimed, true, JSON.stringify(claim));
  const { token } = claim;
  await act(target, { action: 'plan_pages', source: 'entries', token });
  await act(target, {
    action: 'stage_page',
    page: 'p0001',
    rows: [
      {
        entry: entries.get('Counting Alpha-2081/2082/Z').id,
        pattern_mapping: alpha.id,
        year_label: '2081/2082',
      },
    ],
    token,
  });
  const ofAlpha = `filter[pattern_mapping][_eq]=${alpha.id}`;
  const matches = () => get(target, `${matchesPath}?fields=id&${ofAlpha}`);
  const lines = () => get(target, `${countedLinesPath}?fields=id&${ofAlpha}`);
  const staged = await matches();
  const countedBefore = await lines();
  assert.equal(staged.length, 1);
  assert.ok(countedBefore.length > 0);

  await remove(target, `${patternMappingsPath}/${alpha.id}`);
  state.items = state.items.filter(
    ([collection, id]) =>
      collection !== 'moodle_pattern_mappings' || id !== alpha.id,
  );
  assert.deepEqual(await matches(), []);
  assert.deepEqual(await lines(), []);
  await refused(
    target,
    { action: 'complete', token },
    'COORDINATION_SOURCE_CHANGED',
  );
  await countRun(target);
  await assertEqualToResolver(target);
};

// Operation-triggered Flows cannot be reached over REST, and nobody runs
// the synthetic driver without signing in.
const refusesAnonymousTriggers = async (target) => {
  for (const id of [matchFlow.id, dispatcherFlow.id, driverFlowId]) {
    assert.equal(await anonymousTrigger(target, id), 403, id);
  }
};

const cleansUp = async (target, state) => {
  for (const id of [...state.flows, ...state.templatesCreated]) {
    const response = await request(target, `/flows/${id}`, {
      method: 'DELETE',
      token: target.token,
    });
    await response.text();
    assert.ok([204, 403, 404].includes(response.status), `${id}`);
  }
  for (const [collection, id] of state.items) {
    const response = await request(target, `/items/${collection}/${id}`, {
      method: 'DELETE',
      token: target.token,
    });
    await response.text();
    assert.ok([204, 403].includes(response.status), `${collection} ${id}`);
  }
  const mappings = await get(
    target,
    `${patternMappingsPath}?fields=id&limit=-1`,
  );
  await removeAll(
    target,
    patternMappingsPath,
    mappings.map(({ id }) => id),
  );
  const entries = await get(target, `${entriesPath}?fields=id&limit=-1`);
  for (const { id } of entries) {
    await remove(target, `${entriesPath}/${id}`);
  }
  // The counts, counted lines and mappings went with their courses and
  // years (ON DELETE CASCADE), the memberships with their users.
  for (const collection of dataModelCollectionKeys) {
    if (collection === 'data_operations') continue;
    assert.equal(
      await count(target, collection),
      0,
      `${collection} must be empty again`,
    );
  }
};

test('counts every course and academic year by pattern and explicit mappings', async (t) => {
  const target = targetFrom(process.env);
  const directus = adminRequest(target);
  const state = {
    courses: new Map(),
    flows: [],
    ids: new Map(),
    items: [],
    templatesCreated: [],
    years: new Map(),
  };

  await withDataModel(target, async () => {
    try {
      await installDataModel(directus);
      await applySchemaConstraints(directus);
      await applySourceInvalidation(directus);
      await t.test('installs the matching Flow and the dispatcher', () =>
        installsFlows(target, directus, state),
      );
      await t.test(
        'seeds users, courses, years, pattern and explicit mappings',
        () => seeds(target, state),
      );
      await t.test(
        'counts by the precedence rules, exactly as resolveLines does',
        () => countsByThePrecedenceRules(target, state),
      );
      await t.test(
        'gives a new course its default mapping, which a rename keeps',
        () => createsTheDefaultMapping(target, state),
      );
      await t.test('fails a page over the row cap and installs nothing', () =>
        refusesAPageOverTheRowCap(target, state),
      );
      await t.test(
        'removes the counted lines and staged matches of a deleted mapping',
        () => cascadesThroughTheGuards(target, state),
      );
      await t.test('refuses anonymous triggers', () =>
        refusesAnonymousTriggers(target),
      );
    } finally {
      await t.test('removes exactly what it created', () =>
        cleansUp(target, state),
      );
    }
  });

  await assertMarkerPresent(target);
  assert.deepEqual(await userCollections(target), [target.markerCollection]);
});
