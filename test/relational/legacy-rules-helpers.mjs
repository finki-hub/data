import assert from 'node:assert/strict';

import { deriveCourses } from '../../directus/extensions/directus-extension-rebuild-derived-data/derive.js';
import { dispatcherFlowId } from '../../src/flows/count-enrollments.js';
import { insertionOrder } from '../../src/flows/flow-template.js';
import { academicYears } from '../../src/specs/public.js';
import { makeSyntheticDataset } from '../fixtures/synthetic-data.js';
import { get, patch, post, trigger } from './history-index-helpers.mjs';

// Synthetic Flows, seeds and the oracle of the legacy rule fixture suite
// (legacy-rules.integration.mjs). The installed templates are operation
// triggered; the synthetic manual "Synthetic enrollment run" takes one
// enrollments claim and hands it to the installed dispatcher, which plans
// every rule family, runs each through its runner and completes.

const syntheticId = (suffix) => `9e4d826c-5b1a-4c0e-8f2d-0000000012${suffix}`;

export const legacyRunFlowId = syntheticId('10');
export const legacyRunPath = `/flows/trigger/${legacyRunFlowId}`;
export const resultsPath = '/items/data_operation_results';
export const enrollmentsPath = '/items/course_enrollments';
export const rulesPath = '/items/course_enrollment_rules';
// The workbook-era academic years (src/specs/public.ts). The imported
// rules name them by position and the checkpoint derivation (the oracle)
// counts them, so the suite uses the list only where it tests the
// imported rules; everything else names the year rows it created.
export const workbookYears = [...academicYears];

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

const raise = ({ code, key, message, status, suffix }) => [
  suffix,
  key,
  'throw-error',
  { code, message, status },
];

// One claim of the enrollments domain handed to the installed dispatcher
// "Data / Count enrollments", which plans every rule family, runs each
// through its declared runner and completes the claim; a refused run
// raises the dispatcher's own code and message.
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
    'count',
    'trigger',
    {
      flow: dispatcherFlowId,
      iterationMode: 'serial',
      payload: { claim: '{{ claim.token }}', revision: '{{ claim.revision }}' },
    },
    { resolve: '17' },
  ],
  [
    '17',
    'counted',
    'condition',
    { filter: { count: { ok: { _eq: true } } } },
    { reject: '18', resolve: '19' },
  ],
  raise({
    code: '{{ count.code }}',
    key: 'raise_count',
    message: '{{ count.stage }}: {{ count.message }}',
    status: 500,
    suffix: '18',
  }),
  ['19', 'answer', 'transform', { json: '{{ count }}' }],
].map((entry) => step(entry));

// The family of a dispatcher answer, by its rule mode.
export const familyOf = (answer, kind) =>
  answer.families.find((family) => family.kind === kind);

export const installLegacyRunFlow = async (target) => {
  await post(target, '/flows', {
    accountability: 'activity',
    description:
      'Synthetic manual run of the enrollment dispatcher under one enrollments claim; removed by the suite that installs it.',
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
    for (const year of workbookYears) {
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
