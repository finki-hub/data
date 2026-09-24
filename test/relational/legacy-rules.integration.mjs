import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { dataModelCollectionKeys } from '../../src/data-model/collections.js';
import {
  applySchemaConstraints,
  applySourceInvalidation,
} from '../../src/data-model/constraints.js';
import { installDataModel } from '../../src/data-model/install.js';
import { dispatcherFlow } from '../../src/flows/count-enrollments.js';
import { legacyEnrollmentFlows } from '../../src/flows/count-legacy-enrollments.js';
import { mappedEnrollmentFlows } from '../../src/flows/count-mapped-enrollments.js';
import { legacySumsQuery } from '../../src/flows/fill-legacy-zeros.js';
import { flowFamilyCodes } from '../../src/flows/flow-template.js';
import { historyIndexFlows } from '../../src/flows/index-histories.js';
import { installFlowTemplates } from '../../src/flows/install-flows.js';
import { installFlowFamily } from '../../src/flows/registry.js';
import { familyRunnerFlow } from '../../src/flows/run-enrollment-family.js';
import {
  legacyEnrollmentFlowIds,
  mappedEnrollmentFlowIds,
} from '../../src/flows/shared.js';
import { seededRules } from '../legacy-enrollment-helpers.js';
import { targetFrom } from '../search-integration-helpers.mjs';
import {
  adminRequest,
  assertMarkerPresent,
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
  invoke,
  patch,
  post,
  rebuild,
  remove,
  status,
} from './history-index-helpers.mjs';
import { installHistoryRunner } from './history-runner.mjs';
import {
  assertRefusedRun,
  baseSeed,
  candidateRows,
  catastrophicPattern,
  familyOf,
  historyOf,
  installedCounts,
  installedRevisions,
  installLegacyRunFlow,
  legacyRunFlowId,
  longHistory,
  oracle,
  resultsPath,
  rulesPath,
  runEnrollments,
  years,
} from './legacy-rules-helpers.mjs';
import {
  anonymousTrigger,
  drive,
  driverFlowId,
  installDriverFlow,
} from './mapped-enrollments-helpers.mjs';

// The Flows a family install created and skipped.
const flowLists = ({ created, skipped }) => ({ created, skipped });

// The installed dispatcher and the runner every planned family goes
// through, children first.
const dispatcherFlows = [familyRunnerFlow, dispatcherFlow];

const collator = new Intl.Collator('en');
const byKey = (left, right) => collator.compare(left.key, right.key);
const fillerText = /Synthetic Legacy Filler/u;
const privateText =
  /C\+\+|Course-20|Honors|Synthetic Legacy Filler|Theta Lab|a{8}/u;
const invalidRule =
  /Rule (?<rule>\d+) \(course (?<course>\d+) \/ academic year \d+\) has a pattern that does not compile as a unicode regular expression \(Nothing to repeat\); nothing was counted\./u;
const timedOut = /Script execution timed out/u;
const firstLegacyPage = /Legacy page p0002 failed/u;
const overBudget =
  /^plan: Moodle user (?<user>\d+) holds 800001 bytes of Courses history, more than the 800000-byte budget of one legacy rule page; nothing was planned\.$/u;
const legacyFamilyFailed =
  /^family: Enrollment family legacy_regex failed \(family: LEGACY_COUNT_FAILED legacy: LEGACY_COUNT_FAILED /u;
const mappedPair = { 'ma/2025/2026': 2, 'mb/2025/2026': 0 };

// The installed counts must equal the checkpoint derivation of the seed
// for every legacy pair, plus the two mapped pairs.
const expectParity = async (target, state, seed = state.seed) => {
  const expected = { ...(await oracle(seed)), ...mappedPair };
  const installed = await installedCounts(target, state);
  assert.deepEqual(installed, expected);
  return expected;
};

const claimAndPlan = async (target, retry = null) => {
  const claim = await act(target, {
    action: 'claim',
    domain: 'enrollments',
    retry,
  });
  assert.equal(claim.claimed, true, JSON.stringify(claim));
  const plan = await act(target, {
    action: 'plan_pages',
    source: 'enrollments',
    token: claim.token,
  });
  // The planned page plus the claim and its revision: the payload of the
  // page Flows, which check it against the stored plan themselves.
  const pagesOf = (wanted) =>
    plan.families
      .flatMap(({ pages }) => pages)
      .filter(({ kind }) => kind === wanted)
      .map((page) => ({
        ...page,
        claim: claim.token,
        revision: claim.revision,
      }));
  // A planned family as "Data / Run enrollment family" hands it to the
  // runner Flow the plan names.
  const family = (kind) => {
    const planned = plan.families.find((entry) => entry.kind === kind);
    return {
      claim: claim.token,
      kind,
      pages: planned.pages,
      revision: claim.revision,
      runner: planned.runnerFlowId,
    };
  };
  return {
    cells: pagesOf('legacy'),
    claim,
    family,
    mapped: pagesOf('mapped'),
    plan,
    zeros: pagesOf('legacy_zeros'),
  };
};

// Runs one planned family through the runner Flow its plan names.
const runFamily = async (target, planned, kind) => {
  const family = planned.family(kind);
  const [answer] = await drive(target, family.runner, [family]);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  return answer;
};

const installsFlows = async (target, directus, state) => {
  const listed = await get(target, '/flows?fields=id&limit=-1');
  const present = new Set(listed.map(({ id }) => id));
  state.templatesCreated = [
    ...historyIndexFlows,
    ...mappedEnrollmentFlows,
    ...legacyEnrollmentFlows,
    ...dispatcherFlows,
  ]
    .map(({ id }) => id)
    .filter((id) => !present.has(id));
  await installFlowFamily(directus, flowFamilyCodes.history);
  await installFlowFamily(directus, flowFamilyCodes.mapped);
  const first = await installFlowFamily(directus, flowFamilyCodes.legacy);
  // The dispatcher and its family runner only: the rest of the automatic
  // processing family (the schedule) stays as the fixture holds it.
  await installFlowTemplates(directus, dispatcherFlows);
  assert.equal(
    first.created.length + first.skipped.length,
    legacyEnrollmentFlows.length,
  );
  assert.deepEqual(
    flowLists(await installFlowFamily(directus, flowFamilyCodes.legacy)),
    {
      created: [],
      skipped: legacyEnrollmentFlows.map(({ name }) => name),
    },
  );
  for (const flow of [
    ...mappedEnrollmentFlows,
    ...legacyEnrollmentFlows,
    ...dispatcherFlows,
  ]) {
    const live = await get(
      target,
      `/flows/${flow.id}?fields=name,description,status,trigger,accountability,operation,options`,
    );
    assert.deepEqual(live, {
      accountability: 'activity',
      description: flow.description,
      name: flow.name,
      operation: flow.entry,
      options: flow.options,
      status: 'active',
      trigger: 'operation',
    });
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
  state.flows.push(legacyRunFlowId);
  await installLegacyRunFlow(target);
  state.flows.push(historyRunnerId);
  await installHistoryRunner(target);
};

// The Task 2 histories and a 40,000-character one are indexed first; then
// the courses, the fifteen years, the rules the Task 8 converter seeds
// (every course/year, last-id overrides, literal defaults) with two mapped
// rules created between them, and one explicit mapping.
const seeds = async (target, state) => {
  for (const [index, Courses] of state.seed.histories.entries()) {
    state.users.push(
      await create(target, state, [
        'moodle_users',
        { Courses, Name: `Synthetic Legacy User ${index + 1}` },
      ]),
    );
  }
  const indexed = await rebuild(target);
  assert.equal(indexed.status, 200, JSON.stringify(indexed.body));
  for (const course of state.seed.courses) {
    const id = await create(target, state, ['courses', { name: course.name }]);
    state.courseIds.set(course.key, id);
    state.courseKeys.set(id, course.key);
  }
  for (const key of ['ma', 'mb']) {
    const id = await create(target, state, [
      'courses',
      { name: `Synthetic Mapped Course ${key.toUpperCase()}` },
    ]);
    state.courseIds.set(key, id);
    state.courseKeys.set(id, key);
  }
  for (const [index, label] of years.entries()) {
    const id = await create(target, state, [
      'academic_years',
      { label, sort: years.length - index },
    ]);
    state.yearIds.set(label, id);
    state.yearLabels.set(id, label);
  }
  const seeded = await seededRules();
  const ruleOf = ({ academic_year, course, pattern }) => ({
    academic_year: state.yearIds.get(years[academic_year - 1]),
    course: state.courseIds.get(`c${course}`),
    mode: 'legacy_regex',
    pattern,
    review_note: 'Synthetic legacy rule of the fixture suite.',
  });
  const mappedRule = (key) => ({
    academic_year: state.yearIds.get('2025/2026'),
    course: state.courseIds.get(key),
    mode: 'mapped_entries',
  });
  const half = seeded.length / 2;
  for (const batch of [
    seeded.slice(0, half).map(ruleOf),
    [mappedRule('ma')],
    seeded.slice(half).map(ruleOf),
    [mappedRule('mb')],
  ]) {
    const created = await post(target, rulesPath, batch);
    for (const [index, { id }] of created.data.entries()) {
      const rule = batch[index];
      state.rules.set(
        `${state.courseKeys.get(rule.course)}/${state.yearLabels.get(rule.academic_year)}`,
        id,
      );
    }
  }
  const entries = await entriesByLabel(target);
  await create(target, state, [
    'moodle_course_mappings',
    {
      academic_year: state.yearIds.get('2025/2026'),
      course: state.courseIds.get('ma'),
      entry: entries.get('Beta Course-2024/2025').id,
    },
  ]);
  assert.equal(await count(target, 'course_enrollment_rules'), 122);
  const report = await status(target);
  assert.deepEqual(report.pending, ['enrollments', 'publication']);
};

// One claim, one plan of both families, the mapped page through the Task
// 11 page Flow, the legacy family through the installed parent, one
// completion: every pair is installed, zeros included, and equals the
// checkpoint derivation of the same seed.
const countsBothFamilies = async (target, state, context) => {
  const started = performance.now();
  const run = await runEnrollments(target);
  const runMs = Math.round(performance.now() - started);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.deepEqual(
    run.body.families.map(({ kind, pages }) => [kind, pages]),
    [
      ['mapped_entries', 1],
      ['legacy_regex', 2],
    ],
  );
  const legacy = familyOf(run.body, 'legacy_regex').summary;
  assert.deepEqual(legacy, {
    counted: legacy.counted,
    legacyPages: 1,
    ok: true,
    pairs: 120,
    staged: legacy.counted,
    zeroPages: 1,
    zeros: 120 - legacy.counted,
  });
  assert.deepEqual(familyOf(run.body, 'mapped_entries').summary, {
    ok: true,
    pages: 1,
    staged: 2,
  });
  assert.equal(run.body.pages, 3);
  assert.equal(run.body.installed, 122);
  const expected = await expectParity(target, state);
  const nonzero = Object.values(expected).filter((value) => value > 0).length;
  assert.equal(legacy.counted, nonzero - 1);
  assert.deepEqual(await installedRevisions(target), [run.body.revision]);
  assert.deepEqual(await candidateRows(target), []);
  const report = await status(target);
  assert.equal(report.claim, null);
  assert.deepEqual(report.pending, ['publication']);
  assert.doesNotMatch(JSON.stringify(run.body), privateText);
  Object.assign(state, { expected });
  context.diagnostic(
    JSON.stringify({
      counted: nonzero,
      pairs: 122,
      runMs,
      zeros: 122 - nonzero,
    }),
  );
};

// A claim that stages only one family (run through the runner Flow its
// plan names) is refused by the completion (PAGES_MISSING names the other
// family's pages) and installs nothing; with every family staged it
// completes.
const refusesOneFamily = async (target, state) => {
  const before = await installedCounts(target, state);
  await act(target, { action: 'mark', domains: ['enrollments'] });
  const mappedOnly = await claimAndPlan(target);
  assert.equal(
    mappedOnly.family('mapped_entries').runner,
    mappedEnrollmentFlowIds.pages,
  );
  await runFamily(target, mappedOnly, 'mapped_entries');
  const missingLegacy = await invoke(target, {
    action: 'complete',
    token: mappedOnly.claim.token,
  });
  assert.equal(missingLegacy.status, 409, JSON.stringify(missingLegacy.body));
  assert.equal(errorCode(missingLegacy.body), 'COORDINATION_PAGES_MISSING');
  assert.deepEqual(missingLegacy.body.errors[0].extensions.missing, [
    ...mappedOnly.cells.map(({ token }) => token),
    ...mappedOnly.zeros.map(({ token }) => token),
  ]);
  assert.deepEqual(await installedCounts(target, state), before);
  await act(target, {
    action: 'fail',
    code: 'SYNTHETIC_MAPPED_ONLY',
    token: mappedOnly.claim.token,
  });
  const legacyOnly = await claimAndPlan(target, true);
  assert.equal(
    legacyOnly.family('legacy_regex').runner,
    legacyEnrollmentFlowIds.parent,
  );
  await runFamily(target, legacyOnly, 'legacy_regex');
  const missingMapped = await invoke(target, {
    action: 'complete',
    token: legacyOnly.claim.token,
  });
  assert.equal(missingMapped.status, 409, JSON.stringify(missingMapped.body));
  assert.deepEqual(
    missingMapped.body.errors[0].extensions.missing,
    legacyOnly.mapped.map(({ token }) => token),
  );
  assert.deepEqual(await installedCounts(target, state), before);
  await act(target, {
    action: 'fail',
    code: 'SYNTHETIC_LEGACY_ONLY',
    token: legacyOnly.claim.token,
  });
  // Neither table source plans an enrollments claim with legacy rules: a
  // plan of the users or of the rules alone could let the completion drop
  // the legacy pairs. The claim stays unplanned and installs nothing.
  const tableOnly = await act(target, {
    action: 'claim',
    domain: 'enrollments',
    retry: true,
  });
  assert.equal(tableOnly.claimed, true, JSON.stringify(tableOnly));
  for (const source of ['history', 'rules']) {
    const plan = await invoke(target, {
      action: 'plan_pages',
      source,
      token: tableOnly.token,
    });
    assert.equal(plan.status, 409, JSON.stringify(plan.body));
    assert.equal(errorCode(plan.body), 'COORDINATION_DOMAIN_MISMATCH');
  }
  const unplanned = await invoke(target, {
    action: 'complete',
    token: tableOnly.token,
  });
  assert.equal(unplanned.status, 409, JSON.stringify(unplanned.body));
  assert.equal(errorCode(unplanned.body), 'COORDINATION_PAGES_MISSING');
  assert.deepEqual(await installedCounts(target, state), before);
  await act(target, {
    action: 'fail',
    code: 'SYNTHETIC_TABLE_PLAN',
    token: tableOnly.token,
  });
  // The same claim with every family, each through its runner.
  const both = await claimAndPlan(target, true);
  await runFamily(target, both, 'mapped_entries');
  await runFamily(target, both, 'legacy_regex');
  const completed = await act(target, {
    action: 'complete',
    token: both.claim.token,
  });
  assert.equal(completed.installed, 122);
  await expectParity(target, state);
};

// The native sum the zero page reads (legacySumsQuery, its templates
// filled in), over REST: the pairs one claim's rows of the given legacy
// pages count.
const sumsOf = (target, claim, cells) => {
  const values = new Map([
    ['{{ check_zeros.cells }}', cells],
    ['{{ check_zeros.claim }}', claim],
  ]);
  const filter = JSON.stringify(legacySumsQuery.filter, (_key, value) =>
    values.has(value) ? values.get(value) : value,
  );
  const query = new URLSearchParams({
    aggregate: JSON.stringify(legacySumsQuery.aggregate),
    filter,
    groupBy: legacySumsQuery.groupBy.join(','),
    limit: String(legacySumsQuery.limit),
  });
  return get(target, `${resultsPath}?${query}`);
};

// The zero page sums its own legacy pages of its own claim only: its own
// earlier zero rows never enter the sum, and the sum is filtered by claim.
// A foreign claim's rows cannot exist beside it any more (candidates are
// guarded, only the coordinator writes them, under the one live claim, and
// every release discards them; a REST write is refused), so the filter is
// shown the other way round: the same sum under another claim's token
// finds none of this claim's staged rows.
const sumsOwnPagesOnly = async (target, state) => {
  await act(target, { action: 'mark', domains: ['enrollments'] });
  const run = await claimAndPlan(target);
  await drive(target, mappedEnrollmentFlowIds.page, run.mapped);
  const pages = await drive(target, legacyEnrollmentFlowIds.page, run.cells);
  assert.ok(
    pages.every((page) => page.ok !== false),
    JSON.stringify(pages),
  );
  const nonzero = pages.reduce((total, page) => total + page.staged, 0);
  const cells = run.cells.map(({ token }) => token);
  const own = await sumsOf(target, run.claim.token, cells);
  assert.ok(nonzero > 0, 'the legacy pages counted some pairs');
  assert.equal(own.length, nonzero, JSON.stringify(own));
  assert.deepEqual(await sumsOf(target, randomUUID(), cells), []);
  const zeroPair = {
    academic_year: state.yearIds.get('2011/2012'),
    course: state.courseIds.get('c1'),
  };
  assert.equal(state.expected['c1/2011/2012'], 0);
  const foreign = await request(
    target,
    resultsPath,
    json(
      'POST',
      [
        {
          ...zeroPair,
          claim_token: randomUUID(),
          count: 77,
          page_token: run.cells[0].token,
          revision: run.claim.revision,
        },
      ],
      target.token,
    ),
  );
  assert.equal(foreign.status, 403);
  assert.equal(errorCode(await foreign.json()), 'COORDINATION_WRITE_GUARDED');
  const [filled] = await drive(
    target,
    legacyEnrollmentFlowIds.zeros,
    run.zeros,
  );
  assert.deepEqual(filled, {
    counted: nonzero,
    page: run.zeros[0].token,
    rules: 120,
    staged: 120 - nonzero,
    zeros: 120 - nonzero,
  });
  const [replayed] = await drive(
    target,
    legacyEnrollmentFlowIds.zeros,
    run.zeros,
  );
  assert.deepEqual(replayed, filled);
  const completed = await act(target, {
    action: 'complete',
    token: run.claim.token,
  });
  assert.equal(completed.installed, 122);
  await expectParity(target, state);
};

// A Studio-equivalent edit of one pattern (no source code, no Flow edit)
// changes that pair only; restoring the pattern restores parity.
const editsPattern = async (target, state) => {
  const id = state.rules.get('c2/2024/2025');
  const path = `${rulesPath}/${id}`;
  const original = await get(target, `${path}?fields=pattern`);
  await patch(target, path, { pattern: String.raw`Beta Course-2024/2025\r\n` });
  const edited = await runEnrollments(target);
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const changed = await installedCounts(target, state);
  assert.deepEqual(changed, { ...state.expected, 'c2/2024/2025': 1 });
  await patch(target, path, { pattern: original.pattern });
  const restored = await runEnrollments(target);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  await expectParity(target, state);
};

// Refused runs install nothing and leave status failed; the counts and
// their revision stay those of the last successful run.
const expectVisibleFailure = async (target, state, { reason, run }) => {
  const message = assertRefusedRun(run, 500, 'ENROLLMENTS_FAILED');
  assert.match(message, legacyFamilyFailed);
  assert.match(message, reason);
  assert.doesNotMatch(JSON.stringify(run.body), privateText);
  assert.deepEqual(await installedCounts(target, state), state.expected);
  assert.deepEqual(await installedRevisions(target), [state.completed]);
  assert.deepEqual(await candidateRows(target), []);
  const report = await status(target);
  assert.equal(report.claim, null);
  assert.equal(report.lastError.code, 'LEGACY_COUNT_FAILED');
  assert.equal(report.revisions.completed, state.completed);
  assert.ok(report.pending.includes('enrollments'));
  assert.doesNotMatch(JSON.stringify(report), privateText);
  return message;
};

// A course whose name is not a valid Unicode expression seeds literal
// default rules that do not compile: the run fails naming the first rule
// id and course id, as the checkpoint derivation fails on that course.
const refusesInvalidPattern = async (target, state) => {
  const before = await status(target);
  Object.assign(state, { completed: before.revisions.completed });
  const course = await create(target, state, [
    'courses',
    { name: 'C++ Course' },
  ]);
  const created = await post(
    target,
    rulesPath,
    years.map((label) => ({
      academic_year: state.yearIds.get(label),
      course,
      mode: 'legacy_regex',
      pattern: `C++ Course-${label}`,
    })),
  );
  const run = await runEnrollments(target);
  const message = await expectVisibleFailure(target, state, {
    reason: invalidRule,
    run,
  });
  const named = invalidRule.exec(message)?.groups ?? {};
  assert.equal(Number(named.rule), created.data[0].id);
  assert.equal(Number(named.course), course);
  await assert.rejects(
    oracle({
      ...state.seed,
      courses: [...state.seed.courses, { key: 'cpp', name: 'C++ Course' }],
    }),
  );
  await remove(target, `/items/courses/${course}`);
  state.items = state.items.filter(
    ([collection, id]) => collection !== 'courses' || id !== course,
  );
};

// A pathological expression runs into the Run Script timeout: the page
// fails, the run fails visibly, nothing is installed.
const timesOutVisibly = async (target, state, context) => {
  const path = `${rulesPath}/${state.rules.get('c6/2019/2020')}`;
  const original = await get(target, `${path}?fields=pattern`);
  await patch(target, path, { pattern: catastrophicPattern });
  const started = performance.now();
  const run = await runEnrollments(target);
  const runMs = Math.round(performance.now() - started);
  await expectVisibleFailure(target, state, { reason: timedOut, run });
  context.diagnostic(JSON.stringify({ timeoutRunMs: runMs }));
  assert.ok(runMs >= 10_000, `the run took ${runMs} ms`);
  await patch(target, path, { pattern: original.pattern });
  const restored = await runEnrollments(target);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  await expectParity(target, state);
};

// A history over the page budget refuses the plan, naming the user id and
// sizes only; nothing is counted or installed.
const refusesOverBudget = async (target, state) => {
  const user = await create(target, state, [
    'moodle_users',
    {
      Courses: historyOf(800_001, ['Alpha Course-2025/2026']),
      Name: 'Synthetic Legacy Oversized User',
    },
  ]);
  const indexed = await rebuild(target);
  assert.equal(indexed.status, 200, JSON.stringify(indexed.body));
  // The history index completion advances the completed revision; the
  // refused plan must not.
  const before = await status(target);
  const completed = before.revisions.completed;
  const run = await runEnrollments(target);
  const message = assertRefusedRun(run, 500, 'COORDINATION_PAGE_OVER_BUDGET');
  assert.equal(Number(overBudget.exec(message)?.groups?.user), user);
  assert.doesNotMatch(JSON.stringify(run.body), fillerText);
  const report = await status(target);
  assert.equal(report.claim, null);
  assert.equal(report.lastError.code, 'PLAN_FAILED');
  assert.equal(report.revisions.completed, completed);
  assert.doesNotMatch(JSON.stringify(report), fillerText);
  assert.deepEqual(await installedCounts(target, state), state.expected);
  await remove(target, `/items/moodle_users/${user}`);
  state.items = state.items.filter(
    ([collection, id]) => collection !== 'moodle_users' || id !== user,
  );
  const reindexed = await rebuild(target);
  assert.equal(reindexed.status, 200, JSON.stringify(reindexed.body));
};

// Three histories of 300,000 bytes push the users past the byte budget:
// the plan splits them into two history pages, each counted in its own
// Run Script; the counts still equal the checkpoint derivation. Each large
// history ends in a run of "a", so a pathological rule would time out on
// both pages (see stopsAtFirstFailedPage).
const bigHistory = historyOf(300_000, [
  'Gamma Course-2020/2021',
  'a'.repeat(34),
]);

const splitsAtBudget = async (target, state, context) => {
  const big = bigHistory;
  const users = [];
  for (const index of [1, 2, 3]) {
    users.push(
      await create(target, state, [
        'moodle_users',
        { Courses: big, Name: `Synthetic Legacy Large User ${index}` },
      ]),
    );
  }
  Object.assign(state, { bigUsers: users });
  const indexed = await rebuild(target, { retry: true });
  assert.equal(indexed.status, 200, JSON.stringify(indexed.body));
  const run = await claimAndPlan(target, true);
  assert.deepEqual(
    run.cells.map(({ bytes, rows }) => [rows, bytes > 600_000]),
    [
      [state.users.length + 2, true],
      [1, false],
    ],
  );
  assert.ok(run.cells.every(({ bytes }) => bytes <= 800_000));
  await drive(target, mappedEnrollmentFlowIds.page, run.mapped);
  const timings = [];
  for (const cell of run.cells) {
    const started = performance.now();
    const [answer] = await drive(target, legacyEnrollmentFlowIds.page, [cell]);
    timings.push({
      bytes: cell.bytes,
      ms: Math.round(performance.now() - started),
      rules: answer.rules,
      users: answer.users,
    });
  }
  await drive(target, legacyEnrollmentFlowIds.zeros, run.zeros);
  const completed = await act(target, {
    action: 'complete',
    token: run.claim.token,
  });
  assert.equal(completed.installed, 122);
  const seed = {
    ...state.seed,
    histories: [...state.seed.histories, big, big, big],
  };
  const expected = await expectParity(target, state, seed);
  assert.equal(expected['c3/2020/2021'], 3);
  Object.assign(state, { splitExpected: expected });
  context.diagnostic(JSON.stringify({ cells: timings }));
};

// With two history pages that both hold a run of "a", a pathological rule
// times out on the first legacy page only: that page fails the claim at
// once, so the second page refuses in check_page instead of running into
// the timeout again. The run fails after one timeout, visibly, and
// installs nothing; restoring the pattern and removing the large users
// follows.
const stopsAtFirstFailedPage = async (target, state, context) => {
  const path = `${rulesPath}/${state.rules.get('c6/2019/2020')}`;
  const original = await get(target, `${path}?fields=pattern`);
  await patch(target, path, { pattern: catastrophicPattern });
  const before = await status(target);
  const started = performance.now();
  const run = await runEnrollments(target);
  const runMs = Math.round(performance.now() - started);
  const message = assertRefusedRun(run, 500, 'ENROLLMENTS_FAILED');
  assert.match(message, legacyFamilyFailed);
  assert.match(message, timedOut);
  assert.match(message, firstLegacyPage);
  assert.doesNotMatch(JSON.stringify(run.body), privateText);
  context.diagnostic(JSON.stringify({ legacyPages: 2, runMs }));
  assert.ok(runMs >= 10_000, `the run took ${runMs} ms`);
  assert.ok(runMs < 15_000, `the run took ${runMs} ms, more than one timeout`);
  const report = await status(target);
  assert.equal(report.claim, null);
  assert.equal(report.lastError.code, 'LEGACY_COUNT_FAILED');
  assert.equal(report.revisions.completed, before.revisions.completed);
  assert.deepEqual(await candidateRows(target), []);
  assert.deepEqual(await installedCounts(target, state), state.splitExpected);
  await patch(target, path, { pattern: original.pattern });
  for (const id of state.bigUsers) {
    await remove(target, `/items/moodle_users/${id}`);
  }
  state.items = state.items.filter(
    ([collection, id]) =>
      collection !== 'moodle_users' || !state.bigUsers.includes(id),
  );
};

// Without any Moodle user the plan holds no legacy page, the zero page's
// native sum reads an empty page list (page_token _in []) and every pair of
// both families is installed as an explicit zero.
const installsZerosWithoutUsers = async (target, state) => {
  for (const id of state.users) {
    await remove(target, `/items/moodle_users/${id}`);
  }
  const removed = new Set(state.users);
  state.items = state.items.filter(
    ([collection, id]) => collection !== 'moodle_users' || !removed.has(id),
  );
  const indexed = await rebuild(target, { retry: true });
  assert.equal(indexed.status, 200, JSON.stringify(indexed.body));
  const run = await runEnrollments(target, { retry: true });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.deepEqual(familyOf(run.body, 'legacy_regex').summary, {
    counted: 0,
    legacyPages: 0,
    ok: true,
    pairs: 120,
    staged: 0,
    zeroPages: 1,
    zeros: 120,
  });
  assert.equal(run.body.pages, 2);
  assert.equal(run.body.installed, 122);
  const installed = await installedCounts(target, state);
  assert.deepEqual(installed, {
    ...(await oracle({ ...state.seed, histories: [] })),
    'ma/2025/2026': 0,
    'mb/2025/2026': 0,
  });
  assert.ok(Object.values(installed).every((value) => value === 0));
};

const refusesAnonymousTriggers = async (target) => {
  for (const id of [
    ...Object.values(legacyEnrollmentFlowIds),
    ...dispatcherFlows.map((flow) => flow.id),
  ]) {
    assert.equal(await anonymousTrigger(target, id), 403, id);
    const direct = await request(
      target,
      `/flows/trigger/${id}`,
      json('POST', { collection: 'data_operations' }, target.token),
    );
    await direct.text();
    assert.equal(direct.status, 403, id);
  }
  assert.equal(await anonymousTrigger(target, legacyRunFlowId), 403);
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
};

test('counts legacy regex enrollment rules in bounded native Flows', async (t) => {
  const target = targetFrom(process.env);
  const directus = adminRequest(target);
  const state = {
    bigUsers: [],
    completed: null,
    courseIds: new Map(),
    courseKeys: new Map(),
    expected: null,
    flows: [],
    items: [],
    rules: new Map(),
    seed: baseSeed(),
    splitExpected: null,
    templatesCreated: [],
    users: [],
    yearIds: new Map(),
    yearLabels: new Map(),
  };
  assert.equal(longHistory.length, 40_000);

  await withDataModel(target, async () => {
    try {
      await installDataModel(directus);
      await applySchemaConstraints(directus);
      await applySourceInvalidation(directus);
      await t.test('installs the legacy enrollment flows once', () =>
        installsFlows(target, directus, state),
      );
      await t.test(
        'seeds histories, courses, years and both rule families',
        () => seeds(target, state),
      );
      await t.test(
        'installs every pair of both families from one claim, equal to the checkpoint derivation',
        (context) => countsBothFamilies(target, state, context),
      );
      await t.test(
        'refuses to complete a claim that staged only one family',
        () => refusesOneFamily(target, state),
      );
      await t.test(
        "sums only the claim's own legacy pages into the zero page",
        () => sumsOwnPagesOnly(target, state),
      );
      await t.test(
        'counts an edited pattern without a code change and restores parity',
        () => editsPattern(target, state),
      );
      await t.test(
        'fails visibly on a pattern that does not compile and installs nothing',
        () => refusesInvalidPattern(target, state),
      );
      await t.test(
        'fails visibly when a pathological pattern times out and installs nothing',
        (context) => timesOutVisibly(target, state, context),
      );
      await t.test(
        'refuses to plan a history over the page budget without private text',
        () => refusesOverBudget(target, state),
      );
      await t.test(
        'splits history pages at the byte budget and keeps parity',
        (context) => splitsAtBudget(target, state, context),
      );
      await t.test(
        'stops at the first failed page: one timeout, not one per history page',
        (context) => stopsAtFirstFailedPage(target, state, context),
      );
      await t.test(
        'installs explicit zeros for every pair when no Moodle user exists',
        () => installsZerosWithoutUsers(target, state),
      );
      await t.test('refuses anonymous and REST triggers', () =>
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
