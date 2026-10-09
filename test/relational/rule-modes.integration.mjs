import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ruleModes,
  runnerFlowIds,
} from '../../directus/extensions/directus-extension-data-operations/src/rule-modes.js';
import { dataModelCollectionKeys } from '../../src/data-model/collections.js';
import {
  applySchemaConstraints,
  applySourceInvalidation,
} from '../../src/data-model/constraints.js';
import { installDataModel } from '../../src/data-model/install.js';
import { legacyEnrollmentFlows } from '../../src/flows/count-legacy-enrollments.js';
import { mappedEnrollmentFlows } from '../../src/flows/count-mapped-enrollments.js';
import { flowFamilyCodes } from '../../src/flows/flow-template.js';
import { historyIndexFlows } from '../../src/flows/index-histories.js';
import { installFlowTemplates } from '../../src/flows/install-flows.js';
import { installFlowFamily } from '../../src/flows/registry.js';
import {
  legacyEnrollmentFlowIds,
  mappedEnrollmentFlowIds,
} from '../../src/flows/shared.js';
import { assertMarkerPresent, targetFrom } from '../isolated-target.mjs';
import {
  databaseContainer,
  removeFlow,
  runsSince,
  wallClock,
} from './automatic-processing-helpers.mjs';
import {
  adminRequest,
  errorCode,
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
  invoke,
  patch,
  rebuild,
  remove,
  status,
} from './history-index-helpers.mjs';
import { installHistoryRunner } from './history-runner.mjs';
import {
  drive,
  driverFlowId,
  installDriverFlow,
} from './mapped-enrollments-helpers.mjs';
import {
  assertAnswered,
  countsOf,
  courseNames,
  dispatcherFlows,
  expectedCounts,
  flowsIn,
  graphOnFixture,
  lineOf,
  liveFlow,
  probeChild,
  probeChildIds,
  probeFlowIds,
  probeTemplatedTarget,
  rowsOfFlows,
  seedHistories,
  seedMappings,
  seedRules,
  yearLabels,
} from './rule-modes-helpers.mjs';

// Task 26 on the pinned engine: a templated Trigger Flow target resolves;
// the installed dispatcher runs every planned rule family through one
// runner templated from the family, completes only once every family's
// pages are staged, runs the mapped family alone once every rule is
// mapped_entries (no Flow edit, same counts), and its graph is the same
// for a registry without a mode. Everything seeded is removed again.

const dispatcherIds = dispatcherFlows.map(({ id }) => id);
const enrollmentTemplates = [
  ...mappedEnrollmentFlows,
  ...legacyEnrollmentFlows,
  ...dispatcherFlows,
];
const skipUnless = (value, name) =>
  value === undefined ? `${name} is not set` : false;
const pagesMissing = 'COORDINATION_PAGES_MISSING';
const collator = new Intl.Collator('en');
const silentLegacy =
  /^Family legacy_regex failed \[runner ENROLLMENTS_FAILED\]: Runner Flow 6a1d9f0e-2b3c-4d5e-8f70-000000001201: no answer \(inactive or deleted\)$/u;

const claimEnrollments = async (target, retry = null) => {
  const claim = await act(target, {
    action: 'claim',
    domain: 'enrollments',
    retry,
  });
  assert.equal(claim.claimed, true, JSON.stringify(claim));
  return claim;
};

// One enrollments claim run by the installed dispatcher, as the schedule
// runs it: {claim, revision} in, the dispatcher's answer out.
const dispatch = async (target, retry = null) => {
  const claim = await claimEnrollments(target, retry);
  const [answer] = await drive(target, dispatcherFlows[1].id, [
    { claim: claim.token, revision: claim.revision },
  ]);
  return answer;
};

const kindsOf = (answer) =>
  answer.families.map(({ kind, pages }) => [kind, pages]);

const probesTemplatedTarget = async (target) => {
  const { direct, nested } = await probeTemplatedTarget(target);
  assert.deepEqual(assertAnswered(direct), probeChild('C', { page: 1 }));
  // A serial Trigger Flow over families into a runner whose target is
  // templated from each family; an unknown runner answers nothing.
  assert.deepEqual(assertAnswered(nested), [
    probeChild('C', { family: 'first' }),
    probeChild('D', { family: 'second' }),
    null,
  ]);
  for (const id of probeFlowIds) {
    assert.deepEqual(
      await get(target, `/flows?fields=id&filter[id][_eq]=${id}`),
      [],
    );
  }
  assert.notEqual(probeChildIds.c, probeChildIds.d);
};

const installsFlows = async (target, directus, state) => {
  const listed = await get(target, '/flows?fields=id&limit=-1');
  const present = new Set(listed.map(({ id }) => id));
  state.templatesCreated = [...historyIndexFlows, ...enrollmentTemplates]
    .map(({ id }) => id)
    .filter((id) => !present.has(id));
  await installFlowFamily(directus, flowFamilyCodes.history);
  await installFlowFamily(directus, flowFamilyCodes.mapped);
  await installFlowFamily(directus, flowFamilyCodes.legacy);
  await installFlowTemplates(directus, dispatcherFlows);
  for (const flow of enrollmentTemplates) {
    const live = await liveFlow(target, flow.id);
    assert.deepEqual(
      live,
      {
        operation: flow.entry,
        operations: flow.operations
          .map(({ id, key, options, reject, resolve, type }) => ({
            id,
            key,
            options,
            reject,
            resolve,
            type,
          }))
          .toSorted((left, right) => collator.compare(left.id, right.id)),
        options: flow.options,
        status: 'active',
        trigger: flow.trigger,
      },
      flow.name,
    );
  }
  state.flows.push(coordinateFlowId, driverFlowId, historyRunnerId);
  await installSyntheticFlow(target);
  await installDriverFlow(target);
  await installHistoryRunner(target);
};

const seeds = async (target, state) => {
  for (const [index, Courses] of seedHistories.entries()) {
    await create(target, state, [
      'moodle_users',
      { Courses, Name: `Synthetic Mode User ${index + 1}` },
    ]);
  }
  const indexed = await rebuild(target);
  assert.equal(indexed.status, 200, JSON.stringify(indexed.body));
  for (const [key, name] of Object.entries(courseNames)) {
    const id = await create(target, state, [
      'courses',
      { name, pattern_mappings: [] },
    ]);
    state.courseIds.set(key, id);
    state.courseKeys.set(id, key);
  }
  for (const [index, [key, label]] of Object.entries(yearLabels).entries()) {
    const id = await create(target, state, [
      'academic_years',
      { label, sort: index + 1 },
    ]);
    state.yearIds.set(key, id);
    state.yearKeys.set(id, key);
  }
  for (const [course, year, mode] of seedRules) {
    const id = await create(target, state, [
      'course_enrollment_rules',
      {
        academic_year: state.yearIds.get(year),
        course: state.courseIds.get(course),
        mode,
        pattern: mode === 'legacy_regex' ? lineOf(course, year) : null,
        review_note: 'Synthetic rule of the rule-mode suite.',
      },
    ]);
    state.rules.set(`${course}/${year}`, id);
  }
  const entries = await entriesByLabel(target);
  for (const [course, year] of seedMappings) {
    await create(target, state, [
      'moodle_course_mappings',
      {
        academic_year: state.yearIds.get(year),
        course: state.courseIds.get(course),
        entry: entries.get(lineOf(course, year)).id,
      },
    ]);
  }
  const report = await status(target);
  assert.deepEqual(report.pending, ['enrollments', 'publication']);
};

// One claim, one plan of both families: staging only the mapped family
// through its declared runner leaves the completion PAGES_MISSING naming
// exactly the legacy family's pages. The installed dispatcher with the
// legacy runner unavailable fails the claim after the mapped family ran
// and installs nothing; with it back, the same dispatcher completes.
const completesOnlyWithEveryFamily = async (target, state, context) => {
  const claim = await claimEnrollments(target);
  const plan = await act(target, {
    action: 'plan_pages',
    source: 'enrollments',
    token: claim.token,
  });
  assert.deepEqual(
    plan.families.map(({ kind, runnerFlowId }) => [kind, runnerFlowId]),
    ruleModes.map(({ mode, runnerFlowId }) => [mode, runnerFlowId]),
  );
  const [mapped, legacy] = plan.families;
  const [answer] = await drive(target, mapped.runnerFlowId, [
    {
      claim: claim.token,
      kind: mapped.kind,
      pages: mapped.pages,
      revision: claim.revision,
      runner: mapped.runnerFlowId,
    },
  ]);
  assert.deepEqual(answer, { ok: true, pages: 1, staged: 2 });
  const refused = await invoke(target, {
    action: 'complete',
    token: claim.token,
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(errorCode(refused.body), pagesMissing);
  assert.deepEqual(
    refused.body.errors[0].extensions.missing,
    legacy.pages.map(({ token }) => token),
  );
  assert.equal(await count(target, 'course_enrollments'), 0);
  await act(target, {
    action: 'fail',
    code: 'SYNTHETIC_ONE_FAMILY',
    token: claim.token,
  });
  context.diagnostic(
    `mapped family only: ${JSON.stringify({ missing: refused.body.errors[0].extensions.missing, runner: answer })}`,
  );

  const parent = `/flows/${legacyEnrollmentFlowIds.parent}`;
  const since = wallClock();
  await patch(target, parent, { status: 'inactive' });
  let failed;
  try {
    failed = await dispatch(target, true);
  } finally {
    await patch(target, parent, { status: 'active' });
  }
  assert.equal(failed.ok, false, JSON.stringify(failed));
  assert.equal(failed.stage, 'family');
  assert.match(failed.message, silentLegacy);
  assert.equal(
    await runsSince(target, mappedEnrollmentFlowIds.pages, since),
    1,
  );
  assert.equal(await count(target, 'course_enrollments'), 0);
  assert.equal(await count(target, 'data_operation_results'), 0);
  const report = await status(target);
  assert.equal(report.claim, null);
  assert.equal(report.lastError.code, 'ENROLLMENTS_FAILED');
  context.diagnostic(
    `legacy runner inactive: ${JSON.stringify({ answer: failed, lastError: report.lastError.code })}`,
  );

  const counted = await dispatch(target, true);
  assert.equal(counted.ok, true, JSON.stringify(counted));
  assert.deepEqual(kindsOf(counted), [
    ['mapped_entries', 1],
    ['legacy_regex', 2],
  ]);
  assert.equal(counted.installed, 6);
  assert.deepEqual(await countsOf(target, state), expectedCounts);
  const settled = await status(target);
  assert.deepEqual(settled.pending, ['publication']);
  context.diagnostic(
    `both families: ${JSON.stringify({ counts: await countsOf(target, state), families: counted.families, installed: counted.installed })}`,
  );
};

// Every legacy rule becomes mapped_entries (a Studio edit of the mode, no
// Flow edit): the next claim plans the mapped family only, the legacy
// runner never runs, the counts stay, and neither the installed Flows nor
// the calculation fingerprint change.
const runsMappedFamilyAlone = async (target, state, context) => {
  const flowsBefore = await Promise.all(
    enrollmentTemplates.map(({ id }) => liveFlow(target, id)),
  );
  const before = await status(target);
  const legacyRules = seedRules
    .filter((rule) => rule[2] === 'legacy_regex')
    .map(([course, year]) => state.rules.get(`${course}/${year}`));
  await patch(target, '/items/course_enrollment_rules', {
    data: { mode: 'mapped_entries' },
    keys: legacyRules,
  });
  const marked = await status(target);
  assert.deepEqual(marked.pending, ['enrollments', 'publication']);
  const since = wallClock();
  const counted = await dispatch(target);
  assert.equal(counted.ok, true, JSON.stringify(counted));
  assert.deepEqual(kindsOf(counted), [['mapped_entries', 1]]);
  assert.equal(counted.installed, 6);
  assert.deepEqual(await countsOf(target, state), expectedCounts);
  const runs = {
    dispatcher: await runsSince(target, dispatcherIds[1], since),
    family: await runsSince(target, dispatcherIds[0], since),
    legacy: await runsSince(target, legacyEnrollmentFlowIds.parent, since),
    mapped: await runsSince(target, mappedEnrollmentFlowIds.pages, since),
  };
  assert.deepEqual(runs, { dispatcher: 1, family: 1, legacy: 0, mapped: 1 });
  assert.deepEqual(
    await Promise.all(
      enrollmentTemplates.map(({ id }) => liveFlow(target, id)),
    ),
    flowsBefore,
  );
  const after = await status(target);
  assert.equal(
    after.fingerprints.current.calculation,
    before.fingerprints.current.calculation,
  );
  assert.deepEqual(after.pending, ['publication']);
  context.diagnostic(
    `every rule mapped_entries: ${JSON.stringify({ calculationFingerprint: after.fingerprints.current.calculation, families: counted.families, installed: counted.installed, runs })}`,
  );
};

// graphSql on the fixture, for the declared runners and for a registry
// without the legacy mode: the dispatcher's rows are the same, while the
// legacy runner is in the calculation graph only through its declared
// root (no step names it; its pages root the graph by their stage_page).
const keepsDispatcherGraph = async (context) => {
  const withoutLegacy = ruleModes.filter(({ mode }) => mode !== 'legacy_regex');
  const declared = await graphOnFixture(runnerFlowIds());
  const reduced = await graphOnFixture(runnerFlowIds(withoutLegacy));
  assert.deepEqual(
    rowsOfFlows(reduced, dispatcherIds),
    rowsOfFlows(declared, dispatcherIds),
  );
  assert.equal(
    rowsOfFlows(declared, dispatcherIds).length,
    dispatcherFlows.reduce((total, flow) => total + flow.operations.length, 0),
  );
  const familyIds = [...mappedEnrollmentFlows, ...legacyEnrollmentFlows].map(
    ({ id }) => id,
  );
  const full = flowsIn(declared, 'calculation');
  const cut = flowsIn(reduced, 'calculation');
  assert.deepEqual(
    [...familyIds, ...dispatcherIds].filter((id) => !full.has(id)),
    [],
  );
  assert.deepEqual(
    [...familyIds, ...dispatcherIds].filter((id) => !cut.has(id)),
    [legacyEnrollmentFlowIds.parent],
  );
  assert.deepEqual(
    [...flowsIn(declared, 'publication')].filter((id) =>
      [...familyIds, ...dispatcherIds].includes(id),
    ),
    [],
  );
  context.diagnostic(
    `graphSql rows: ${JSON.stringify({ declared: declared.length, dispatcherRows: rowsOfFlows(declared, dispatcherIds).length, withoutLegacy: reduced.length })}`,
  );
};

const cleansUp = async (target, state) => {
  for (const id of [...state.flows, ...state.templatesCreated]) {
    await removeFlow(target, id);
  }
  for (const [collection, id] of state.items) {
    await remove(target, `/items/${collection}/${id}`);
  }
  const entries = await get(target, `${entriesPath}?fields=id&limit=-1`);
  for (const { id } of entries) {
    await remove(target, `${entriesPath}/${id}`);
  }
  for (const collection of dataModelCollectionKeys) {
    if (collection === 'data_operations') continue;
    assert.equal(
      await count(target, collection),
      0,
      `${collection} must be empty again`,
    );
  }
  const parent = await get(
    target,
    `/flows/${legacyEnrollmentFlowIds.parent}?fields=status`,
  );
  assert.equal(parent.status, 'active');
};

test('runs every declared rule family through one family-generic dispatcher', async (t) => {
  const target = targetFrom(process.env);
  const directus = adminRequest(target);
  const state = {
    courseIds: new Map(),
    courseKeys: new Map(),
    flows: [],
    items: [],
    rules: new Map(),
    templatesCreated: [],
    yearIds: new Map(),
    yearKeys: new Map(),
  };

  await withDataModel(target, async () => {
    try {
      await installDataModel(directus);
      await applySchemaConstraints(directus);
      await applySourceInvalidation(directus);
      await t.test(
        'resolves a templated Trigger Flow target on the pinned engine',
        () => probesTemplatedTarget(target),
      );
      await t.test('installs the family runners and the dispatcher once', () =>
        installsFlows(target, directus, state),
      );
      await t.test('seeds both rule families and indexes the histories', () =>
        seeds(target, state),
      );
      await t.test(
        "completes a claim of both families only once every family's pages are staged",
        (context) => completesOnlyWithEveryFamily(target, state, context),
      );
      await t.test(
        'runs the mapped family alone once every rule is mapped_entries, with no Flow edit and unchanged counts',
        (context) => runsMappedFamilyAlone(target, state, context),
      );
      await t.test(
        'keeps the dispatcher graph for a registry without a mode and roots every declared runner',
        {
          skip: skipUnless(
            databaseContainer,
            'DIRECTUS_AUTOMATIC_DATABASE_CONTAINER',
          ),
        },
        (context) => keepsDispatcherGraph(context),
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
