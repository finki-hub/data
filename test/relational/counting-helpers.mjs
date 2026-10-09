import assert from 'node:assert/strict';

import {
  countPairs,
  defaultYearPattern,
  resolveLines,
} from '../../directus/extensions/directus-extension-data-operations/src/enrollment-lines.js';
import { json, read, request } from './data-model-helpers.mjs';
import { get, patch, post, trigger } from './history-index-helpers.mjs';

// Seeds, a synthetic driver Flow and read helpers of the counting fixture
// suite (counting.integration.mjs). The installed "Data / Count
// enrollments" and "Data / Match history lines" are operation-triggered
// and cannot be reached over REST, so a synthetic manual Flow runs them
// with a payload. Every row is invented.

const idPrefix = '9e4d826c-5b1a-4c0e-8f2d-0000000017';
const syntheticId = (suffix) => `${idPrefix}${suffix}`;

export const driverFlowId = syntheticId('01');
const driverPath = `/flows/trigger/${driverFlowId}`;
export const enrollmentsPath = '/items/course_enrollments';
export const patternMappingsPath = '/items/moodle_pattern_mappings';
export const countedLinesPath = '/items/moodle_counted_lines';
export const matchesPath = '/items/data_operation_matches';

export const otherYearPattern = String.raw`(?<start>\d{4})-(?<end>\d{4})`;

// Synthetic raw histories: a course's lines in two year forms, a line
// with no year, a year no academic year carries, a line an explicit
// mapping takes, a line no mapping counts, and a later course's line.
export const seedUsers = [
  ['u1', 'Counting Alpha-2081/2082/Z\nCounting Alpha-2082/2083/L'],
  ['u2', 'Counting Alpha 2082-2083\nCounting Beta-2082/2083/Z'],
  ['u3', 'Counting Alpha-no year\nCounting Alpha-2090/2091/Z'],
  ['u4', 'Counting Beta-2083/2084/Z\nCounting Beta Lab-2083/2084/Z'],
  ['u5', 'Counting Gamma-2082/2083/Z\nCounting Gamma Hand-2082/2083/Z'],
  ['u6', 'Counting Alpha-2081/2082/Z\r\nCounting Unlisted'],
  ['u7', 'Counting Beta-2083/2084/Z'],
  ['u8', 'Counting Delta-2082/2083/Z'],
];

// key, label, sort
export const seedYears = [
  ['y1', '2081/2082', 81],
  ['y2', '2082/2083', 82],
  ['y3', '2083/2084', 83],
];

// course, pattern, year pattern or only-in-year year
export const seedMappings = [
  ['a', '^Counting Alpha-', { year_pattern: defaultYearPattern }],
  ['a', '^Counting Alpha ', { year_pattern: otherYearPattern }],
  ['b', '^Counting Beta-', { year_pattern: defaultYearPattern }],
  ['b', 'Lab-', { only_in_year: 'y3' }],
  ['c', '^Counting Gamma', { year_pattern: defaultYearPattern }],
];

// entry label, course, academic year
export const seedExplicit = [['Counting Gamma Hand-2082/2083/Z', 'b', 'y2']];

// The counts of the seeds, by "course/year" key: Alpha in both year
// forms, Beta's 2083/2084 replaced by its lab line, Gamma's hand-mapped
// line counted for Beta, and a zero wherever nothing counts.
export const firstCounts = {
  'a/y1': 2,
  'a/y2': 2,
  'a/y3': 0,
  'b/y1': 0,
  'b/y2': 2,
  'b/y3': 1,
  'c/y1': 0,
  'c/y2': 1,
  'c/y3': 0,
};

const installFlow = async (target, flow, operations) => {
  await post(target, '/flows', {
    ...flow,
    operation: null,
    status: 'inactive',
  });
  for (const operation of operations) {
    await post(target, '/operations', { ...operation, flow: flow.id });
  }
  await patch(target, `/flows/${flow.id}`, {
    operation: operations.at(-1).id,
    status: 'active',
  });
};

// Runs any operation-triggered Flow with the posted payload (an object
// runs once and answers its result).
export const installDriverFlow = (target) =>
  installFlow(
    target,
    {
      accountability: 'activity',
      description:
        'Synthetic driver of operation-triggered Flows; removed by the suite that installs it.',
      icon: 'science',
      id: driverFlowId,
      name: 'Synthetic counting driver',
      options: {
        async: false,
        collections: ['data_operations'],
        error_on_reject: true,
        location: 'both',
        requireSelection: false,
      },
      trigger: 'manual',
    },
    [
      {
        id: syntheticId('02'),
        key: 'run_child',
        name: 'run_child',
        options: {
          flow: '{{ $trigger.body.flow }}',
          iterationMode: 'serial',
          payload: '{{ $trigger.body.payload }}',
        },
        position_x: 19,
        position_y: 1,
        reject: null,
        resolve: null,
        type: 'trigger',
      },
    ],
  );

export const drive = async (target, flow, payload) => {
  const outcome = await trigger(target, driverPath, {
    collection: 'data_operations',
    flow,
    payload,
  });
  assert.equal(outcome.status, 200, JSON.stringify(outcome.body));
  return outcome.body;
};

export const anonymousTrigger = async (target, id) => {
  const response = await request(
    target,
    `/flows/trigger/${id}`,
    json('POST', { collection: 'data_operations' }),
  );
  await response.text();
  return response.status;
};

export const removeAll = async (target, path, ids) => {
  if (ids.length === 0) return;
  await read(
    await request(target, path, json('DELETE', ids, target.token)),
    204,
  );
};

// The installed counts by "course/year" key of the seeded ids; rows of
// other courses or years are named by their ids.
export const enrollmentCounts = async (target, state) => {
  const rows = await get(
    target,
    `${enrollmentsPath}?fields=course,academic_year,count&limit=-1`,
  );
  return Object.fromEntries(
    rows.map((row) => [
      `${state.courses.get(row.course) ?? row.course}/${state.years.get(row.academic_year) ?? row.academic_year}`,
      row.count,
    ]),
  );
};

const byRow = (left, right) =>
  left.entry - right.entry ||
  left.course - right.course ||
  left.academicYear - right.academicYear ||
  (left.patternMapping ?? 0) - (right.patternMapping ?? 0);

// What the counting rules give over the rows the database holds:
// resolveLines and countPairs of enrollment-lines.ts, read through the
// API (the counted lines and every count row of every course and year).
export const resolvedFromDatabase = async (target) => {
  const [lines, mappings, explicit, years, courses, memberships] =
    await Promise.all([
      get(target, '/items/moodle_course_entries?fields=id,label&limit=-1'),
      get(
        target,
        `${patternMappingsPath}?fields=id,course,pattern,year_pattern,only_in_year&limit=-1`,
      ),
      get(
        target,
        '/items/moodle_course_mappings?fields=entry,course,academic_year&limit=-1',
      ),
      get(target, '/items/academic_years?fields=id,label&limit=-1'),
      get(target, '/items/courses?fields=id&sort=id&limit=-1'),
      get(
        target,
        '/items/moodle_history_memberships?fields=entry,moodle_user&limit=-1',
      ),
    ]);
  const counted = resolveLines({
    explicit: explicit.map((row) => ({
      academicYear: row.academic_year,
      course: row.course,
      entry: row.entry,
    })),
    lines,
    mappings: mappings.map((row) => ({
      course: row.course,
      id: row.id,
      onlyInYear: row.only_in_year,
      pattern: row.pattern,
      yearPattern: row.year_pattern,
    })),
    years,
  });
  const sortedYears = years.toSorted((left, right) => left.id - right.id);
  return {
    counted,
    counts: countPairs({
      counted,
      courses,
      memberships: memberships.map((row) => ({
        entry: row.entry,
        moodleUser: row.moodle_user,
      })),
      years: sortedYears,
    }),
  };
};

// The counted lines and count rows the completion installed, in the
// order of resolvedFromDatabase.
export const installedFromDatabase = async (target) => {
  const [lines, counts] = await Promise.all([
    get(
      target,
      `${countedLinesPath}?fields=entry,course,academic_year,source,pattern_mapping&limit=-1`,
    ),
    get(
      target,
      `${enrollmentsPath}?fields=course,academic_year,count&sort=course,academic_year&limit=-1`,
    ),
  ]);
  return {
    counted: lines
      .map((row) => ({
        academicYear: row.academic_year,
        course: row.course,
        entry: row.entry,
        patternMapping: row.pattern_mapping,
        source: row.source,
      }))
      .toSorted(byRow),
    counts: counts.map((row) => ({
      academicYear: row.academic_year,
      count: row.count,
      course: row.course,
    })),
  };
};
