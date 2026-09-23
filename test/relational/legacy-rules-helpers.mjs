import assert from 'node:assert/strict';

import { deriveCourses } from '../../directus/extensions/directus-extension-rebuild-derived-data/derive.js';
import { insertionOrder } from '../../src/flows/flow-template.js';
import {
  legacyEnrollmentFlowIds,
  mappedEnrollmentFlowIds,
} from '../../src/flows/shared.js';
import { academicYears } from '../../src/specs/public.js';
import { makeSyntheticDataset } from '../fixtures/synthetic-data.js';
import { get, patch, post, trigger } from './history-index-helpers.mjs';

// Synthetic Flows, seeds and the oracle of the legacy rule fixture suite
// (legacy-rules.integration.mjs). The installed templates are operation
// triggered; the synthetic manual "Synthetic enrollment run" plays the
// Task 13 dispatcher: one enrollments claim, one plan of both families,
// the mapped pages, the legacy family, one completion.

const syntheticId = (suffix) => `9e4d826c-5b1a-4c0e-8f2d-0000000012${suffix}`;

export const legacyRunFlowId = syntheticId('10');
export const legacyRunPath = `/flows/trigger/${legacyRunFlowId}`;
export const resultsPath = '/items/data_operation_results';
export const enrollmentsPath = '/items/course_enrollments';
export const rulesPath = '/items/course_enrollment_rules';
export const years = [...academicYears];

// Filler lines of synthetic histories: 100 distinct short lines that match
// no rule, so a long history adds bytes and entries without counts.
export const filler = (bytes) => {
  const lines = [];
  let length = 0;
  while (length < bytes) {
    const line = `Synthetic Legacy Filler ${String(lines.length % 100).padStart(3, '0')}`;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join('\n').slice(0, bytes);
};

// A history of exactly `bytes` ASCII bytes ending in the given lines.
export const historyOf = (bytes, tail) => {
  const end = tail.join('\n');
  return `${filler(bytes - end.length - 1)}\n${end}`;
};

// 40,000 characters: filler, the Zeta 2019/2020 entry and a run of 34 "a"
// that makes (a+)+b backtrack catastrophically.
export const longHistory = historyOf(40_000, [
  'Zeta Course-2019/2020',
  'a'.repeat(34),
]);

export const catastrophicPattern = '(a+)+b';

// Adds the claim and its revision to every mapped page of the plan, the
// payload the Task 11 page Flow expects.
const mappedPagesScript = `module.exports = function (data) {
  return data.plan.pages.filter(function (page) { return page.kind === 'mapped'; }).map(function (page) {
    return { claim: data.claim.token, from: page.from, revision: data.claim.revision, rows: page.rows, to: page.to, token: page.token };
  });
};`;

const mappedOkScript = `module.exports = function (data) {
  const results = Array.isArray(data.count_mapped) ? data.count_mapped : [];
  const failed = results.filter(function (result) { return result === null || typeof result !== 'object' || typeof result.staged !== 'number'; });
  if (failed.length > 0 || results.length !== data.mapped_pages.length) {
    const first = failed[0] || {};
    throw new Error('Mapped count failed at page ' + String(first.page) + ' (' + String(first.stage) + '): ' + String(first.code) + ' ' + String(first.message).slice(0, 300));
  }
  return { pages: results.length, staged: results.reduce(function (total, result) { return total + result.staged; }, 0) };
};`;

const coordinate = 'finki-hub-data-coordinate';

const step = ([suffix, key, type, options, edges = {}]) => ({
  id: syntheticId(suffix),
  key,
  name: key,
  options,
  position_x: 18 * Number.parseInt(suffix, 16),
  position_y: 1,
  reject: edges.reject === undefined ? null : syntheticId(edges.reject),
  resolve: edges.resolve === undefined ? null : syntheticId(edges.resolve),
  type,
});

const failRun = ({ code, key, next, suffix }) => [
  suffix,
  key,
  coordinate,
  { action: 'fail', code, token: '{{ claim.token }}' },
  { resolve: next },
];

const raise = ({ code, key, message, status, suffix }) => [
  suffix,
  key,
  'throw-error',
  { code, message, status },
];

const runOperations = [
  [
    '13',
    'claim',
    coordinate,
    {
      action: 'claim',
      domain: 'enrollments',
      retry: '{{ $trigger.body.retry }}',
    },
    { resolve: '14' },
  ],
  [
    '14',
    'claimed',
    'condition',
    { filter: { claim: { claimed: { _eq: true } } } },
    { reject: '15', resolve: '16' },
  ],
  raise({
    code: 'NOT_CLAIMED',
    key: 'not_claimed',
    message: 'Enrollments not claimed: {{ claim.reason }}',
    status: 409,
    suffix: '15',
  }),
  [
    '16',
    'plan',
    coordinate,
    { action: 'plan_pages', source: 'enrollments', token: '{{ claim.token }}' },
    { reject: '17', resolve: '19' },
  ],
  failRun({ code: 'PLAN_FAILED', key: 'plan_fail', next: '18', suffix: '17' }),
  raise({
    code: 'PLAN_REFUSED',
    key: 'raise_plan',
    message: '{{ plan.message }}',
    status: 500,
    suffix: '18',
  }),
  [
    '19',
    'mapped_pages',
    'exec',
    { code: mappedPagesScript },
    { resolve: '1a' },
  ],
  [
    '1a',
    'count_mapped',
    'trigger',
    {
      flow: mappedEnrollmentFlowIds.page,
      iterationMode: 'serial',
      payload: '{{ mapped_pages }}',
    },
    { resolve: '1b' },
  ],
  [
    '1b',
    'mapped_ok',
    'exec',
    { code: mappedOkScript },
    { reject: '1c', resolve: '1e' },
  ],
  failRun({
    code: 'MAPPED_COUNT_FAILED',
    key: 'mapped_fail',
    next: '1d',
    suffix: '1c',
  }),
  raise({
    code: 'MAPPED_COUNT_FAILED',
    key: 'raise_mapped',
    message: '{{ mapped_ok.message }}',
    status: 500,
    suffix: '1d',
  }),
  [
    '1e',
    'count_legacy',
    'trigger',
    {
      flow: legacyEnrollmentFlowIds.parent,
      iterationMode: 'serial',
      payload: { claim: '{{ claim.token }}' },
    },
    { resolve: '1f' },
  ],
  [
    '1f',
    'legacy_ok',
    'condition',
    { filter: { count_legacy: { ok: { _eq: true } } } },
    { reject: '20', resolve: '22' },
  ],
  raise({
    code: 'LEGACY_COUNT_FAILED',
    key: 'raise_legacy',
    message:
      '{{ count_legacy.stage }}: {{ count_legacy.code }} {{ count_legacy.message }}',
    status: 500,
    suffix: '20',
  }),
  [
    '22',
    'complete',
    coordinate,
    { action: 'complete', token: '{{ claim.token }}' },
    { reject: '23', resolve: '24' },
  ],
  raise({
    code: 'COMPLETION_REFUSED',
    key: 'raise_completion',
    message: '{{ complete.message }}',
    status: 409,
    suffix: '23',
  }),
  [
    '24',
    'answer',
    'transform',
    {
      json: {
        completed: true,
        installed: '{{ complete.installed }}',
        legacy: '{{ count_legacy }}',
        mapped: '{{ mapped_ok }}',
        pages: '{{ plan.total }}',
        revision: '{{ complete.revision }}',
      },
    },
  ],
].map((entry) => step(entry));

export const installLegacyRunFlow = async (target) => {
  await post(target, '/flows', {
    accountability: 'activity',
    description:
      'Synthetic test parent of both enrollment families (the Task 13 dispatcher in miniature); removed by the suite that installs it.',
    icon: 'science',
    id: legacyRunFlowId,
    name: 'Synthetic enrollment run',
    operation: null,
    options: {
      async: false,
      collections: ['course_enrollment_rules', 'data_operations'],
      error_on_reject: true,
      location: 'both',
      requireSelection: false,
    },
    status: 'inactive',
    trigger: 'manual',
  });
  for (const operation of insertionOrder(runOperations)) {
    await post(target, '/operations', { ...operation, flow: legacyRunFlowId });
  }
  await patch(target, `/flows/${legacyRunFlowId}`, {
    operation: syntheticId('13'),
    status: 'active',
  });
};

export const runEnrollments = (target, body = {}) =>
  trigger(target, legacyRunPath, {
    collection: 'data_operations',
    ...body,
  });

// The checkpoint derivation over the seeded courses, patterns and
// histories: the count of every course/year keyed "<course key>/<year>".
export const oracle = async (seed) => {
  const updates = await deriveCourses({
    courseEnrollmentPatterns: seed.patterns,
    courseEquivalencies: [],
    courses: seed.courses.map(({ key, name }) => ({ id: key, name })),
    curriculum2018: [],
    curriculum2023: [],
    moodleUsers: seed.histories.map((Courses) => ({ Courses })),
    teachingAssignments: [],
  });
  const counts = {};
  for (const update of updates) {
    for (const year of years) {
      counts[`${update.id}/${year}`] =
        update[`enrollment_${year.replace('/', '_')}`];
    }
  }
  return counts;
};

// The seed the checkpoint derivation sees: the Task 2 courses, pattern
// rows and histories plus the long synthetic history.
export const baseSeed = () => {
  const dataset = makeSyntheticDataset();
  return {
    courses: dataset.courses.map((course) => ({
      key: `c${course.id}`,
      name: course.name,
      source: course.id,
    })),
    histories: [
      ...dataset.moodle_users.map((user) => user.Courses),
      longHistory,
    ],
    patterns: dataset.course_enrollment_patterns,
  };
};

// The installed counts keyed "<course key>/<year label>".
export const installedCounts = async (target, state) => {
  const rows = await get(
    target,
    `${enrollmentsPath}?fields=course,academic_year,count,computed_revision&limit=-1`,
  );
  return Object.fromEntries(
    rows.map((row) => [
      `${state.courseKeys.get(row.course)}/${state.yearLabels.get(row.academic_year)}`,
      row.count,
    ]),
  );
};

export const installedRevisions = async (target) => {
  const rows = await get(
    target,
    `${enrollmentsPath}?fields=computed_revision&limit=-1`,
  );
  return [...new Set(rows.map(({ computed_revision }) => computed_revision))];
};

export const candidateRows = (target) =>
  get(
    target,
    `${resultsPath}?fields=claim_token,page_token,course,academic_year,count&limit=-1`,
  );

export const assertRefusedRun = (run, status, code) => {
  assert.equal(run.status, status, JSON.stringify(run.body));
  assert.equal(run.body?.errors?.[0]?.extensions?.code, code);
  return run.body.errors[0].message;
};
