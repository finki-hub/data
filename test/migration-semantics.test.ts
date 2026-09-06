import { describe, expect, test } from 'vitest';

import {
  type DataRow,
  academicYears as deriveAcademicYears,
  deriveCourses,
  DerivedDataError,
  deriveStudentCouncil,
} from '../directus/extensions/directus-extension-rebuild-derived-data/derive.js';
import { collectionSpecs } from '../src/model.js';
import { type CollectionKey, collectionKeys } from '../src/schema.js';
import {
  academicYears,
  courseNames,
  makeSyntheticDataset,
  metacharacterCourseName,
  privateSentinels,
  sentinelPrivateId,
  sentinelPrivateMail,
  sentinelPrivateSourceGroup,
  type SyntheticDataset,
  type SyntheticRow,
  toCouncilSources,
  toCourseSources,
  withMetacharacterCourse,
} from './fixtures/synthetic-data.js';

const enrollmentKey = (year: string): string =>
  `enrollment_${year.replace('/', '_')}`;

const byText = (left: string, right: string): number =>
  left.localeCompare(right);

const byNumber = (left: number, right: number): number => left - right;

const exampleDomain = /^[a-z0-9.-]+\.example$/u;

const alphaCurrentName = 'Alpha Course (2023)';
const alphaLegacyName = 'Alpha Legacy';
const betaLegacyName = 'Beta Legacy Manual';

const stringValues = (dataset: SyntheticDataset): readonly string[] =>
  collectionKeys.flatMap((key) =>
    dataset[key].flatMap((row) =>
      Object.values(row).filter((value) => typeof value === 'string'),
    ),
  );

const specTargets = (key: CollectionKey): readonly string[] =>
  collectionSpecs
    .find((spec) => spec.key === key)
    ?.fields.map(({ target }) => target) ?? [];

const deriveByName = async (
  dataset: SyntheticDataset = makeSyntheticDataset(),
): Promise<ReadonlyMap<string, DataRow>> => {
  const updates = await deriveCourses(toCourseSources(dataset));

  return new Map(
    dataset.courses.map((course) => [
      String(course['name']),
      updates.find((update) => update['id'] === course.id) ?? {},
    ]),
  );
};

const withPatterns = (
  dataset: SyntheticDataset,
  keep: (pattern: SyntheticRow) => boolean,
): SyntheticDataset => ({
  ...dataset,
  course_enrollment_patterns: dataset.course_enrollment_patterns.filter(keep),
});

// Replaces every pattern row of the given course with a single override row.
const withPatternRow = (
  dataset: SyntheticDataset,
  row: SyntheticRow,
): SyntheticDataset => ({
  ...dataset,
  course_enrollment_patterns: [
    ...dataset.course_enrollment_patterns.filter(
      (pattern) => pattern['course_name'] !== row['course_name'],
    ),
    row,
  ],
});

// Drops the curriculum rows carrying the given names from both generations.
const withoutCurriculumRows = (
  dataset: SyntheticDataset,
  names: readonly string[],
): SyntheticDataset => {
  const keep = (row: SyntheticRow): boolean =>
    !names.includes(String(row['name']));

  return {
    ...dataset,
    curriculum_2018: dataset.curriculum_2018.filter(keep),
    curriculum_2023: dataset.curriculum_2023.filter(keep),
  };
};

const curriculumNames = (rows: readonly SyntheticRow[]): readonly string[] =>
  rows.map((row) => String(row['name']));

const stateKeys = (states: readonly string[], suffix: string): string[] =>
  states.map((state) => `state_${state}_${suffix}`);

const currentKeys = [
  'channel_2023',
  'code_2023',
  'level_2023',
  'prerequisite_2023',
  'semester_2023',
  ...stateKeys(['kn', 'siis', 'pit', 'imb', 'ki', 'ie', 'ssp', 'seis'], '2023'),
];

const legacyKeys = [
  'channel_2018',
  'code_2018',
  'level_2018',
  'prerequisite_2018',
  'semester_2018',
  ...stateKeys(['kn', 'siis', 'pit', 'imb', 'ki', 'ke', 'seis'], '2018'),
];

const derivedCourseKeys = [
  'assistants',
  'channel',
  'id',
  ...currentKeys,
  ...legacyKeys,
  ...academicYears.map(enrollmentKey),
  'name_2018',
  'professors',
];

const nullValues = (keys: readonly string[]): Record<string, null> =>
  Object.fromEntries(keys.map((key) => [key, null]));

describe('synthetic fixture', () => {
  test('contains every migration collection with ascending unique ids', () => {
    const dataset = makeSyntheticDataset();

    expect(Object.keys(dataset).toSorted(byText)).toEqual(
      [...collectionKeys].toSorted(byText),
    );

    for (const key of collectionKeys) {
      const ids = dataset[key].map((row) => row.id);

      expect(ids).not.toHaveLength(0);
      expect(ids).toEqual(ids.toSorted(byNumber));
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test('is deterministic and hands out fresh objects', () => {
    const first = makeSyntheticDataset();
    const second = makeSyntheticDataset();

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.courses).not.toBe(first.courses);
    expect(second.courses[0]).not.toBe(first.courses[0]);
  });

  test('uses exactly the spec field keys plus id in every collection', () => {
    const dataset = makeSyntheticDataset();

    for (const key of collectionKeys) {
      const expected = ['id', ...specTargets(key)].toSorted(byText);
      const rows = dataset[key];
      for (const row of rows) {
        expect(Object.keys(row).toSorted(byText)).toEqual(expected);
      }
    }
  });

  test('orders course and Moodle columns like the specs', () => {
    const dataset = makeSyntheticDataset();

    for (const course of dataset.courses) {
      expect(Object.keys(course)).toEqual(['id', ...specTargets('courses')]);
    }
    for (const user of dataset.moodle_users) {
      expect(Object.keys(user)).toEqual(['id', ...specTargets('moodle_users')]);
    }

    expect(specTargets('moodle_users')).toHaveLength(38);
  });

  test('uses .example addresses only', () => {
    const addresses = stringValues(makeSyntheticDataset()).filter((value) =>
      value.includes('@'),
    );

    expect(addresses).not.toHaveLength(0);

    for (const address of addresses) {
      expect(address.slice(address.lastIndexOf('@') + 1)).toMatch(
        exampleDomain,
      );
    }
  });

  test('keeps private sentinels out of the public collections', () => {
    const dataset = makeSyntheticDataset();
    const publicRows = JSON.stringify([
      dataset.courses,
      dataset.rooms,
      dataset.staff,
      dataset.students.map((row) => ({ ...row, source_group: null })),
    ]);

    for (const sentinel of privateSentinels) {
      expect(publicRows).not.toContain(sentinel);
    }

    expect(JSON.stringify(dataset.students)).toContain(
      sentinelPrivateSourceGroup,
    );
    expect(JSON.stringify(dataset.moodle_users)).toContain(sentinelPrivateMail);
    expect(JSON.stringify(dataset.moodle_users)).toContain(sentinelPrivateId);
  });

  test('lists the same academic years as the derivation module', () => {
    expect([...deriveAcademicYears]).toEqual([...academicYears]);
  });
});

describe('curriculum lookups', () => {
  test('resolves the current generation through name_2023, not the canonical name', async () => {
    const rows = await deriveByName();

    expect(rows.get(courseNames.alpha)).toMatchObject({
      code_2023: 'SYN23-001',
      level_2023: 1,
      semester_2023: 1,
      channel_2023: true,
      state_kn_2023: 'mandatory',
    });
  });

  test('uses the first ascending-id row when a curriculum name repeats', async () => {
    const rows = await deriveByName();

    expect(rows.get(courseNames.alpha)?.['code_2023']).toBe('SYN23-001');
    expect(rows.get(courseNames.alpha)?.['code_2018']).toBe('SYN18-001');
    expect(rows.get(courseNames.alpha)?.['state_kn_2018']).toBe('mandatory');
  });

  test('resolves the legacy generation through the first equivalency of the canonical name', async () => {
    const rows = await deriveByName();

    expect(rows.get(courseNames.alpha)).toMatchObject({
      name_2018: alphaLegacyName,
      code_2018: 'SYN18-001',
      level_2018: 1,
      semester_2018: 2,
      channel_2018: false,
      state_pit_2018: 'elective',
      state_ke_2018: 'elective',
    });
  });

  test('prefers name_2018_override to the equivalency', async () => {
    const rows = await deriveByName();

    expect(rows.get(courseNames.beta)).toMatchObject({
      name_2018: betaLegacyName,
      code_2018: 'SYN18-002-MANUAL',
      channel_2018: true,
      prerequisite_2018: 'SYN18-001',
    });
  });

  test('treats an empty name_2018_override as absent', async () => {
    const rows = await deriveByName();

    expect(rows.get(courseNames.epsilon)).toMatchObject({
      name_2018: 'Epsilon Legacy',
      code_2018: 'SYN18-005',
    });
  });

  test('leaves the legacy generation empty for a 2013-only equivalency', async () => {
    const rows = await deriveByName();

    expect(rows.get(courseNames.gamma)).toMatchObject({
      code_2023: 'SYN23-003',
      state_pit_2023: 'mandatory',
      name_2018: null,
      ...nullValues(legacyKeys),
    });
  });

  test('keeps the requested legacy label when no curriculum_2018 row carries it', async () => {
    const dataset = withoutCurriculumRows(makeSyntheticDataset(), [
      alphaLegacyName,
      betaLegacyName,
    ]);
    const rows = await deriveByName(dataset);

    // The decoy row under the canonical course name is still there to tempt a fallback.
    expect(curriculumNames(dataset.curriculum_2018)).toContain(
      courseNames.alpha,
    );
    expect(curriculumNames(dataset.curriculum_2018)).not.toContain(
      alphaLegacyName,
    );

    expect(rows.get(courseNames.alpha)).toMatchObject({
      name_2018: alphaLegacyName,
      ...nullValues(legacyKeys),
      code_2023: 'SYN23-001',
      channel_2023: true,
      channel: true,
    });
    expect(rows.get(courseNames.beta)).toMatchObject({
      name_2018: betaLegacyName,
      ...nullValues(legacyKeys),
      code_2023: 'SYN23-002',
      channel_2023: false,
      channel: false,
    });
  });

  test('never falls back to the canonical name when name_2023 misses', async () => {
    const dataset = withoutCurriculumRows(makeSyntheticDataset(), [
      alphaCurrentName,
    ]);
    const rows = await deriveByName(dataset);

    expect(curriculumNames(dataset.curriculum_2023)).toContain(
      courseNames.alpha,
    );
    expect(curriculumNames(dataset.curriculum_2023)).not.toContain(
      alphaCurrentName,
    );

    expect(rows.get(courseNames.alpha)).toMatchObject({
      ...nullValues(currentKeys),
      name_2018: alphaLegacyName,
      code_2018: 'SYN18-001',
      channel_2018: false,
      channel: false,
    });
    expect(JSON.stringify(rows.get(courseNames.alpha))).not.toContain('DECOY');
  });

  test('leaves both generations empty when neither label resolves', async () => {
    const dataset = withoutCurriculumRows(makeSyntheticDataset(), [
      alphaCurrentName,
      alphaLegacyName,
    ]);
    const rows = await deriveByName(dataset);

    expect(rows.get(courseNames.alpha)).toMatchObject({
      ...nullValues(currentKeys),
      ...nullValues(legacyKeys),
      name_2018: alphaLegacyName,
      channel: false,
      professors: 'Prof. Zed Alpha, Prof. Abe Alpha',
    });
  });

  test('leaves every lookup empty for a course without name_2023 or equivalency', async () => {
    const rows = await deriveByName();
    const delta = rows.get(courseNames.delta);

    expect(delta).toEqual({
      id: 4,
      assistants: null,
      channel: false,
      professors: null,
      name_2018: null,
      ...nullValues(
        derivedCourseKeys.filter(
          (key) => key.endsWith('_2023') || key.endsWith('_2018'),
        ),
      ),
      ...Object.fromEntries(
        academicYears.map((year) => [
          enrollmentKey(year),
          year === '2021/2022' ? 1 : 0,
        ]),
      ),
    });
  });

  test('leaves name_2018 empty when no equivalency exists', async () => {
    const rows = await deriveByName();

    expect(rows.get(courseNames.iota)).toMatchObject({
      code_2023: 'SYN23-008',
      name_2018: null,
      code_2018: null,
    });
  });

  test('maps empty curriculum strings to null and keeps null channels null', async () => {
    const rows = await deriveByName();

    expect(rows.get(courseNames.zeta)).toMatchObject({
      channel_2023: null,
      code_2023: null,
      level_2023: null,
      prerequisite_2023: null,
      semester_2023: 6,
      state_kn_2023: null,
      channel_2018: false,
      code_2018: 'SYN18-006',
    });
    expect(rows.get(courseNames.alpha)).toMatchObject({
      state_imb_2023: null,
      state_pit_2023: null,
    });
  });
});

describe('professor and assistant text', () => {
  test('prefers professors_override to the assignment', async () => {
    const rows = await deriveByName();

    expect(rows.get(courseNames.beta)).toMatchObject({
      professors: 'Prof. Beta Override',
      assistants: 'Asst. Beta Assigned',
    });
  });

  test('keeps professors_override without an assignment and has no assistant override', async () => {
    const rows = await deriveByName();

    expect(rows.get(courseNames.gamma)).toMatchObject({
      professors: 'Prof. Gamma Override',
      assistants: null,
    });
  });

  test('treats an empty professors_override as absent', async () => {
    const dataset = makeSyntheticDataset();
    const rows = await deriveByName(dataset);

    expect(
      dataset.courses.find((course) => course['name'] === courseNames.theta)?.[
        'professors_override'
      ],
    ).toBe('');
    expect(rows.get(courseNames.theta)).toMatchObject({
      professors: 'Prof. Theta',
      assistants: 'Asst. Theta',
    });
  });

  test('copies assignment text literally without splitting or reordering names', async () => {
    const rows = await deriveByName();

    expect(rows.get(courseNames.alpha)).toMatchObject({
      professors: 'Prof. Zed Alpha, Prof. Abe Alpha',
      assistants: 'Asst. Alpha One; Asst. Alpha Two',
    });
  });

  test('uses the first ascending-id assignment when a course repeats', async () => {
    const rows = await deriveByName();

    expect(rows.get(courseNames.alpha)?.['professors']).not.toContain('Later');
    expect(rows.get(courseNames.alpha)?.['assistants']).not.toContain('Later');
  });

  test('maps empty assignment text to null', async () => {
    const rows = await deriveByName();

    expect(rows.get(courseNames.zeta)).toMatchObject({
      professors: null,
      assistants: 'Asst. Zeta',
    });
    expect(rows.get(courseNames.epsilon)).toMatchObject({
      professors: 'Prof. Epsilon',
      assistants: null,
    });
  });

  test('leaves both texts null without an assignment or override', async () => {
    const rows = await deriveByName();

    expect(rows.get(courseNames.delta)).toMatchObject({
      professors: null,
      assistants: null,
    });
  });
});

describe('channel availability', () => {
  test.each([
    { name: courseNames.alpha, current: true, legacy: false, expected: true },
    { name: courseNames.beta, current: false, legacy: true, expected: true },
    { name: courseNames.epsilon, current: true, legacy: true, expected: true },
    { name: courseNames.theta, current: true, legacy: false, expected: true },
    { name: courseNames.gamma, current: false, legacy: null, expected: false },
    { name: courseNames.iota, current: false, legacy: null, expected: false },
    { name: courseNames.zeta, current: null, legacy: false, expected: false },
    { name: courseNames.delta, current: null, legacy: null, expected: false },
  ])(
    '$name: channel is the OR of the selected curriculum channels ($current, $legacy -> $expected)',
    async ({ name, current, legacy, expected }) => {
      const rows = await deriveByName();

      expect(rows.get(name)).toMatchObject({
        channel: expected,
        channel_2023: current,
        channel_2018: legacy,
      });
    },
  );

  test('ignores discord_channels entirely', async () => {
    const dataset = makeSyntheticDataset();
    const mentioned = dataset.discord_channels.flatMap((row) =>
      String(row['course_names']).split('\n'),
    );
    const rows = await deriveByName(dataset);

    expect(Object.keys(toCourseSources(dataset))).not.toContain(
      'discord_channels',
    );
    expect(mentioned).toEqual([
      courseNames.gamma,
      courseNames.delta,
      courseNames.zeta,
    ]);

    for (const name of mentioned) {
      expect(rows.get(name)?.['channel']).toBe(false);
    }

    expect(rows.get(courseNames.epsilon)).toMatchObject({ channel: true });
    expect(JSON.stringify(rows.values().toArray())).not.toContain(
      'gamma-and-delta',
    );
  });

  test('does not equate a null generation channel with false', async () => {
    const rows = await deriveByName();
    const zeta = rows.get(courseNames.zeta);

    expect(zeta?.['channel']).toBe(false);
    expect(zeta?.['channel_2023']).toBeNull();
    expect(zeta?.['channel_2018']).toBe(false);
  });
});

describe('generation-specific state fields', () => {
  test('derives ie and ssp states for 2023 only and ke for 2018 only', async () => {
    const rows = await deriveByName();
    const epsilon = rows.get(courseNames.epsilon);

    expect(epsilon).toMatchObject({
      state_kn_2023: 'kn-state',
      state_siis_2023: 'siis-state',
      state_pit_2023: 'pit-state',
      state_imb_2023: 'imb-state',
      state_ki_2023: 'ki-state',
      state_ie_2023: 'ie-state',
      state_ssp_2023: 'ssp-state',
      state_seis_2023: 'seis-state',
      state_kn_2018: 'kn-legacy',
      state_siis_2018: 'siis-legacy',
      state_pit_2018: 'pit-legacy',
      state_imb_2018: 'imb-legacy',
      state_ki_2018: 'ki-legacy',
      state_ke_2018: 'ke-legacy',
      state_seis_2018: 'seis-legacy',
    });
    expect(epsilon).not.toHaveProperty('state_ie_2018');
    expect(epsilon).not.toHaveProperty('state_ssp_2018');
    expect(epsilon).not.toHaveProperty('state_ke_2023');
  });

  test('keeps numeric levels and semesters as numbers', async () => {
    const rows = await deriveByName();

    expect(rows.get(courseNames.epsilon)).toMatchObject({
      level_2023: 3,
      semester_2023: 5,
      level_2018: 3,
      semester_2018: 6,
    });
  });
});

describe('enrollment counting', () => {
  test('uses the name-year default pattern across LF and CRLF histories', async () => {
    const rows = await deriveByName();

    expect(rows.get(courseNames.beta)?.[enrollmentKey('2024/2025')]).toBe(2);
    expect(rows.get(courseNames.epsilon)?.[enrollmentKey('2023/2024')]).toBe(1);
  });

  test('counts a user once even when the history repeats the entry', async () => {
    const rows = await deriveByName();

    expect(rows.get(courseNames.alpha)?.[enrollmentKey('2024/2025')]).toBe(2);
  });

  test('applies the last ascending-id override and replaces the default', async () => {
    const dataset = makeSyntheticDataset();
    const year = enrollmentKey('2025/2026');
    const both = await deriveByName(dataset);
    const firstOnly = await deriveByName(
      withPatterns(dataset, (pattern) => pattern.id !== 2),
    );
    const noOverride = await deriveByName(
      withPatterns(
        dataset,
        (pattern) => pattern['course_name'] !== courseNames.alpha,
      ),
    );

    expect(both.get(courseNames.alpha)?.[year]).toBe(2);
    expect(firstOnly.get(courseNames.alpha)?.[year]).toBe(1);
    expect(noOverride.get(courseNames.alpha)?.[year]).toBe(1);
  });

  test('matches unanchored substrings of the raw history', async () => {
    const rows = await deriveByName();

    expect(rows.get(courseNames.alpha)?.[enrollmentKey('2023/2024')]).toBe(1);
  });

  test('does not escape regex metacharacters in course names', async () => {
    const rows = await deriveByName();

    expect(rows.get(courseNames.iota)?.[enrollmentKey('2022/2023')]).toBe(1);
  });

  test('rejects a course name that is not a valid regular expression', async () => {
    const sources = toCourseSources(
      withMetacharacterCourse(makeSyntheticDataset()),
    );

    await expect(deriveCourses(sources)).rejects.toThrow(DerivedDataError);
    await expect(deriveCourses(sources)).rejects.toThrow(
      `Invalid enrollment pattern for ${metacharacterCourseName} in 2025/2026`,
    );
  });

  test('compiles patterns in unicode mode', async () => {
    const year = enrollmentKey('2025/2026');
    const rows = await deriveByName(
      withPatternRow(makeSyntheticDataset(), {
        id: 99,
        course_name: courseNames.alpha,
        academic_year: '2025/2026',
        pattern: String.raw`Alpha Course\u{2D}2025/2026`,
      }),
    );

    // Only the u flag reads \u{2D} as a hyphen; without it nothing matches.
    expect(rows.get(courseNames.alpha)?.[year]).toBe(1);
  });

  test('rejects an identity escape that unicode mode forbids', async () => {
    const sources = toCourseSources(
      withPatternRow(makeSyntheticDataset(), {
        id: 99,
        course_name: courseNames.alpha,
        academic_year: '2025/2026',
        pattern: String.raw`Alpha Course\-2025/2026`,
      }),
    );

    await expect(deriveCourses(sources)).rejects.toThrow(DerivedDataError);
    await expect(deriveCourses(sources)).rejects.toThrow(
      `Invalid enrollment pattern for ${courseNames.alpha} in 2025/2026`,
    );
  });

  test('lets whole-text patterns cross line boundaries', async () => {
    const rows = await deriveByName();

    expect(rows.get(courseNames.theta)?.[enrollmentKey('2021/2022')]).toBe(2);
    expect(rows.get(courseNames.delta)?.[enrollmentKey('2021/2022')]).toBe(1);
  });

  test('ignores null and empty histories', async () => {
    const dataset = makeSyntheticDataset();
    const rows = await deriveByName({
      ...dataset,
      moodle_users: dataset.moodle_users.filter(
        (user) => user['Courses'] === null || user['Courses'] === '',
      ),
    });

    expect(rows.size).toBe(dataset.courses.length);

    for (const row of rows.values()) {
      for (const year of academicYears) {
        expect(row[enrollmentKey(year)]).toBe(0);
      }
    }
  });

  test('emits a numeric count for all fifteen academic years', async () => {
    const rows = await deriveByName();

    for (const row of rows.values()) {
      for (const year of academicYears) {
        expect(row[enrollmentKey(year)]).toBeTypeOf('number');
      }
    }
  });
});

describe('update shape and untouched inputs', () => {
  test('emits one update per course in input order with exactly the derived keys', async () => {
    const dataset = makeSyntheticDataset();
    const updates = await deriveCourses(toCourseSources(dataset));

    expect(updates.map((update) => update['id'])).toEqual(
      dataset.courses.map((course) => course.id),
    );

    for (const update of updates) {
      expect(Object.keys(update).toSorted(byText)).toEqual(
        derivedCourseKeys.toSorted(byText),
      );
    }
  });

  test('never rewrites Courses Count, discord data or manual course columns', async () => {
    const dataset = makeSyntheticDataset();
    const before = JSON.stringify(dataset);
    const updates = await deriveCourses(toCourseSources(dataset));
    const keys = new Set(updates.flatMap((update) => Object.keys(update)));

    expect(JSON.stringify(dataset)).toBe(before);

    for (const forbidden of [
      'Courses Count',
      'Courses',
      'course_names',
      'name',
      'name_2023',
      'name_2018_override',
      'professors_override',
      'tags',
      'credits_2023',
      'available_2023',
    ]) {
      expect(keys).not.toContain(forbidden);
    }

    expect(dataset.moodle_users.map((user) => user['Courses Count'])).toEqual([
      3,
      3,
      42,
      2,
      2,
      3,
      null,
      2,
      0,
    ]);
  });

  test('never emits a private sentinel', async () => {
    const dataset = makeSyntheticDataset();
    const output = JSON.stringify([
      await deriveCourses(toCourseSources(dataset)),
      deriveStudentCouncil(toCouncilSources(dataset)),
    ]);

    for (const sentinel of privateSentinels) {
      expect(output).not.toContain(sentinel);
    }
  });

  test('tolerates orphan and duplicate source rows', async () => {
    const dataset = makeSyntheticDataset();
    const orphanNames = [
      'Orphan Current Course',
      'Orphan Legacy Course',
      'Orphan Equivalent Course',
      'Orphan Assignment Course',
      'Omega Orphan Course',
    ];
    const updates = await deriveCourses(toCourseSources(dataset));

    expect(updates).toHaveLength(dataset.courses.length);
    expect(JSON.stringify(dataset)).toContain('Ancient Only');

    for (const name of orphanNames) {
      expect(JSON.stringify(dataset)).toContain(name);
      expect(JSON.stringify(updates)).not.toContain(name);
    }
  });

  test('rebuilding the fixture reproduces its stored derived columns', async () => {
    const dataset = makeSyntheticDataset();
    const updates = await deriveCourses(toCourseSources(dataset));

    expect(updates).toHaveLength(dataset.courses.length);

    for (const [index, update] of updates.entries()) {
      const course = dataset.courses[index];

      expect(update).toEqual(
        Object.fromEntries(
          Object.keys(update).map((key) => [key, course?.[key]]),
        ),
      );
    }
  });
});

describe('student council', () => {
  test('resolves names from the first student row per index', () => {
    expect(
      deriveStudentCouncil(toCouncilSources(makeSyntheticDataset())),
    ).toEqual([
      { id: 1, name: 'Synthetic Student One' },
      { id: 2, name: null },
      { id: 3, name: 'Synthetic Student Two' },
      { id: 4, name: null },
    ]);
  });

  test('keeps duplicate student rows and never rewrites the directory', () => {
    const dataset = makeSyntheticDataset();
    const before = JSON.stringify(dataset);

    deriveStudentCouncil(toCouncilSources(dataset));

    expect(JSON.stringify(dataset)).toBe(before);
    expect(
      dataset.students.filter((row) => row['index_number'] === 'SYN-0001'),
    ).toHaveLength(2);
  });

  test('emits only id and name per member', () => {
    const members = deriveStudentCouncil(
      toCouncilSources(makeSyntheticDataset()),
    );
    for (const row of members) {
      expect(Object.keys(row).toSorted(byText)).toEqual(['id', 'name']);
    }
  });

  test.each([
    [
      { id: 5, index_number: '' },
      'Student council member 5 is missing index_number',
    ],
    [
      { index_number: 'SYN-0001' },
      'Student council member is missing its primary key',
    ],
  ])('rejects %j', (member, message) => {
    expect(() =>
      deriveStudentCouncil({ members: [member], students: [] }),
    ).toThrow(DerivedDataError);
    expect(() =>
      deriveStudentCouncil({ members: [member], students: [] }),
    ).toThrow(message);
  });
});

describe('derivation guards', () => {
  test.each([
    [{ courses: [{ id: 1, name: '' }] }, 'Course 1 is missing name'],
    [
      { courses: [{ name: 'No Id Course' }] },
      'Course is missing its primary key',
    ],
    [
      {
        courseEnrollmentPatterns: [
          {
            academic_year: '2025/2026',
            course_name: 'Alpha Course',
            pattern: '',
          },
        ],
      },
      'Enrollment pattern is missing pattern',
    ],
  ])('rejects %j', async (override, message) => {
    const sources = { ...toCourseSources(makeSyntheticDataset()), ...override };

    await expect(deriveCourses(sources)).rejects.toThrow(DerivedDataError);
    await expect(deriveCourses(sources)).rejects.toThrow(message);
  });
});
