import { describe, expect, test } from 'vitest';

import {
  deriveCourses,
  deriveStudentCouncil,
} from '../directus/extensions/directus-extension-rebuild-derived-data/derive.js';
import { readInventory } from '../src/migrations/inventory.js';
import { preflight } from '../src/migrations/preflight.js';
import {
  type MigrationReport,
  migrationReportSchema,
  migrationVersion,
} from '../src/migrations/report.js';
import {
  academicYears,
  courseNames,
  makeSyntheticDataset,
  metacharacterCourseName,
  privateSentinels,
  type SyntheticDataset,
  type SyntheticRow,
  toCouncilSources,
  toCourseSources,
  withMetacharacterCourse,
} from './fixtures/synthetic-data.js';
import {
  fakeItemsDirectus,
  type FakeStore,
  storeFromDataset,
} from './migration-test-helpers.js';

const hexPattern = /^[0-9a-f]{64}$/u;
const studentName = 'Synthetic Student';
const alphaCurrentName = 'Alpha Course (2023)';
const alphaLegacyName = 'Alpha Legacy';
const thetaProfessor = 'Prof. Theta';

const enrollmentKey = (year: string): string =>
  `enrollment_${year.replace('/', '_')}`;

// The synthetic dataset without its deliberate duplicates: one curriculum row
// per label, one equivalency label per course, one assignment and one pattern
// per course and year, and one student per index.
const uniqueDataset = (base = makeSyntheticDataset()): SyntheticDataset => ({
  ...base,
  course_enrollment_patterns: base.course_enrollment_patterns.filter(
    (row) => row.id !== 2,
  ),
  course_equivalencies: base.course_equivalencies.filter((row) => row.id !== 2),
  curriculum_2018: base.curriculum_2018.filter((row) => row.id !== 9),
  curriculum_2023: base.curriculum_2023.filter((row) => row.id !== 2),
  students: base.students.filter((row) => row.id !== 2),
  teaching_assignments: base.teaching_assignments.filter((row) => row.id !== 2),
});

const withCourse = (
  dataset: SyntheticDataset,
  name: string,
  values: Record<string, boolean | null | number | string>,
): SyntheticDataset => ({
  ...dataset,
  courses: dataset.courses.map((course) =>
    course['name'] === name ? { ...course, ...values } : course,
  ),
});

const staffRow = (id: number, name: string, active = true): SyntheticRow => ({
  id,
  name,
  active,
  title: null,
  position: null,
  email: null,
  cabinet: null,
  profile: null,
  courses: null,
  consultations: null,
});

const reportFor = async (
  dataset: SyntheticDataset,
  options: { readonly installed?: boolean; readonly pageSize?: number } = {},
): Promise<{ report: MigrationReport; store: FakeStore }> => {
  const store = storeFromDataset(dataset, {
    installed: options.installed ?? true,
  });
  const { request } = fakeItemsDirectus(store);
  const inventory = await readInventory(request, {
    pageSize: options.pageSize ?? 3,
  });
  return { report: preflight(inventory, null), store };
};

const reportOf = async (store: FakeStore): Promise<MigrationReport> => {
  const { request } = fakeItemsDirectus(store);
  return preflight(await readInventory(request, {}), null);
};

const findings = (report: MigrationReport, code: string) =>
  [...report.blockers, ...report.warnings].filter(
    (finding) => finding.code === code,
  );

const shapes = (report: MigrationReport, code: string) =>
  findings(report, code).map(({ collection, ids }) => ({ collection, ids }));

const courseCandidate = (report: MigrationReport, name: string) => {
  const candidate = report.candidates.courses.find(
    (course) => course.name === name,
  );
  if (candidate === undefined) {
    throw new Error(`No candidate for ${name}`);
  }
  return candidate;
};

// The derivation maps an empty curriculum code to null.
const codeOf = (row: SyntheticRow | undefined): unknown =>
  row?.['code'] === '' ? null : (row?.['code'] ?? null);

// Every candidate rule as an explicit pattern row, one per course and year.
const frozenPatterns = (report: MigrationReport): readonly SyntheticRow[] =>
  report.candidates.courses.flatMap((course, courseIndex) =>
    course.rules.map((rule, ruleIndex) => ({
      id: courseIndex * academicYears.length + ruleIndex + 1,
      course_name: course.name,
      academic_year: rule.academicYear,
      pattern: rule.pattern,
    })),
  );

describe('curriculum candidates reproduce the locked derivation', () => {
  test('resolves current entries through name_2023 with the first ascending id', async () => {
    const dataset = makeSyntheticDataset();
    const { report } = await reportFor(dataset);
    const updates = await deriveCourses(toCourseSources(dataset));

    for (const course of report.candidates.courses) {
      const update = updates.find((row) => row['id'] === course.id);
      const precedentRow = dataset.curriculum_2023.find(
        (row) => row.id === course.current.precedent,
      );

      expect(codeOf(precedentRow)).toBe(update?.['code_2023'] ?? null);
    }

    expect(courseCandidate(report, courseNames.alpha).current).toEqual({
      label: alphaCurrentName,
      matches: [1, 2],
      precedent: 1,
      resolution: 'ambiguous',
    });
    expect(courseCandidate(report, courseNames.delta).current).toEqual({
      label: null,
      matches: [],
      precedent: null,
      resolution: 'none',
    });
  });

  test('resolves legacy entries through the override, else the first equivalency, with the first ascending id', async () => {
    const dataset = makeSyntheticDataset();
    const { report } = await reportFor(dataset);
    const updates = await deriveCourses(toCourseSources(dataset));

    for (const course of report.candidates.courses) {
      const update = updates.find((row) => row['id'] === course.id);
      const precedentRow = dataset.curriculum_2018.find(
        (row) => row.id === course.legacy.entry.precedent,
      );

      expect(course.legacy.label).toBe(update?.['name_2018'] ?? null);
      expect(codeOf(precedentRow)).toBe(update?.['code_2018'] ?? null);
    }

    expect(courseCandidate(report, courseNames.alpha).legacy).toEqual({
      entry: {
        label: alphaLegacyName,
        matches: [1, 9],
        precedent: 1,
        resolution: 'ambiguous',
      },
      equivalencies: {
        label: courseNames.alpha,
        matches: [1, 2],
        precedent: 1,
        resolution: 'ambiguous',
      },
      label: alphaLegacyName,
      source: 'equivalency',
    });
    expect(courseCandidate(report, courseNames.beta).legacy).toMatchObject({
      entry: { matches: [3], precedent: 3, resolution: 'unique' },
      label: 'Beta Legacy Manual',
      source: 'override',
    });
    expect(courseCandidate(report, courseNames.epsilon).legacy.source).toBe(
      'equivalency',
    );
    expect(courseCandidate(report, courseNames.gamma).legacy).toMatchObject({
      entry: { label: null, matches: [], precedent: null, resolution: 'none' },
      label: null,
      source: 'none',
    });
  });
});

describe('assignment and rule candidates reproduce the locked derivation', () => {
  test('uses the first ascending assignment and keeps its text literal', async () => {
    const dataset = makeSyntheticDataset();
    const { report } = await reportFor(dataset);
    const updates = await deriveCourses(toCourseSources(dataset));

    for (const course of report.candidates.courses) {
      const update = updates.find((row) => row['id'] === course.id);
      const assignment = dataset.teaching_assignments.find(
        (row) => row.id === course.assignment.chosen,
      );
      const professors =
        course.professorsOverride ?? assignment?.['professors'] ?? null;

      expect(professors === '' ? null : professors).toBe(
        update?.['professors'] ?? null,
      );
    }
    const alpha = courseCandidate(report, courseNames.alpha);

    expect(alpha.assignment).toEqual({
      chosen: 1,
      matches: [1, 2],
      rule: 'first_id',
    });
    expect(alpha.staff.map(({ text }) => text)).toEqual([
      'Prof. Zed Alpha, Prof. Abe Alpha',
      'Asst. Alpha One; Asst. Alpha Two',
    ]);
    expect(
      alpha.staff.every(({ resolution }) => resolution === 'unresolved'),
    ).toBeTruthy();
    expect(courseCandidate(report, courseNames.beta).professorsOverride).toBe(
      'Prof. Beta Override',
    );
    expect(
      courseCandidate(report, courseNames.theta).professorsOverride,
    ).toBeNull();
  });

  test('links staff only through complete labels of an unambiguous delimited text', async () => {
    const dataset = makeSyntheticDataset();
    const { report } = await reportFor({
      ...dataset,
      staff: [
        ...dataset.staff,
        staffRow(4, 'Prof. Zed Alpha'),
        staffRow(5, 'Prof. Abe Alpha'),
        staffRow(6, 'Asst. Alpha One; Asst. Alpha Two'),
        staffRow(7, thetaProfessor),
        staffRow(8, thetaProfessor, false),
      ],
    });
    const alpha = courseCandidate(report, courseNames.alpha);

    expect(alpha.staff).toEqual([
      {
        parts: ['Prof. Zed Alpha', 'Prof. Abe Alpha'],
        resolution: 'unique',
        role: 'professor',
        staff: [4, 5],
        text: 'Prof. Zed Alpha, Prof. Abe Alpha',
      },
      {
        parts: ['Asst. Alpha One; Asst. Alpha Two'],
        resolution: 'unique',
        role: 'assistant',
        staff: [6],
        text: 'Asst. Alpha One; Asst. Alpha Two',
      },
    ]);
    expect(courseCandidate(report, courseNames.theta).staff[0]).toEqual({
      parts: [thetaProfessor],
      resolution: 'ambiguous',
      role: 'professor',
      staff: [7, 8],
      text: thetaProfessor,
    });
    expect(findings(report, 'ambiguous_staff_label')).toEqual([
      expect.objectContaining({
        collection: 'teaching_assignments',
        ids: [7],
        label: courseNames.theta,
      }),
    ]);
    expect(findings(report, 'ambiguous_staff_label')[0]?.message).toContain(
      '7, 8',
    );
    expect(findings(report, 'duplicate_staff_name')).toEqual([
      expect.objectContaining({
        collection: 'staff',
        ids: [7, 8],
        label: thetaProfessor,
      }),
    ]);
    expect(report.blockers.map(({ code }) => code)).not.toContain(
      'ambiguous_staff_label',
    );
    expect(findings(report, 'unresolved_staff_text').length).toBeGreaterThan(0);
  });

  test('resolves and reports the staff text of every assignment row, not only the first row per course', async () => {
    const dataset = makeSyntheticDataset();
    const { report } = await reportFor(dataset);
    const textsOf = (id: number) =>
      report.candidates.assignments
        .find((row) => row.id === id)
        ?.staff.map(({ resolution, role, text }) => [role, text, resolution]);

    expect(report.candidates.assignments.map(({ id }) => id)).toEqual(
      dataset.teaching_assignments.map(({ id }) => id),
    );
    expect(textsOf(2)).toEqual([
      ['professor', 'Prof. Later Alpha', 'unresolved'],
      ['assistant', 'Asst. Later Alpha', 'unresolved'],
    ]);
    expect(textsOf(6)).toEqual([
      ['professor', 'Prof. Orphan', 'unresolved'],
      ['assistant', 'Asst. Orphan', 'unresolved'],
    ]);
    expect(textsOf(5)).toEqual([
      ['professor', null, 'none'],
      ['assistant', 'Asst. Zeta', 'unresolved'],
    ]);
    expect(
      findings(report, 'unresolved_staff_text').map(({ ids, label }) => [
        ids[0],
        label,
      ]),
    ).toEqual([
      [1, courseNames.alpha],
      [1, courseNames.alpha],
      [2, courseNames.alpha],
      [2, courseNames.alpha],
      [3, courseNames.beta],
      [3, courseNames.beta],
      [4, courseNames.epsilon],
      [5, courseNames.zeta],
      [6, 'Orphan Assignment Course'],
      [6, 'Orphan Assignment Course'],
      [7, courseNames.theta],
      [7, courseNames.theta],
      [8, courseNames.iota],
      [8, courseNames.iota],
    ]);

    const serialized = JSON.stringify(report);

    for (const retained of [
      'Prof. Later Alpha',
      'Asst. Later Alpha',
      'Prof. Orphan',
      'Asst. Orphan',
    ]) {
      expect(serialized).toContain(retained);
    }

    expect(courseCandidate(report, courseNames.alpha).staff).toEqual(
      report.candidates.assignments.find((row) => row.id === 1)?.staff,
    );
  });
});

describe('rule and council candidates reproduce the locked derivation', () => {
  test('seeds one rule per course and year with the last ascending override, else the name-year default', async () => {
    const dataset = makeSyntheticDataset();
    const { report } = await reportFor(dataset);
    const alpha = courseCandidate(report, courseNames.alpha);

    for (const course of report.candidates.courses) {
      expect(course.rules.map(({ academicYear }) => academicYear)).toEqual([
        ...academicYears,
      ]);
      expect(course.rules.every(({ valid }) => valid)).toBeTruthy();
    }

    expect(alpha.rules[0]).toEqual({
      academicYear: '2025/2026',
      chosen: 2,
      overrides: [1, 2],
      pattern: 'Alpha Honors-2025/2026',
      source: 'override',
      valid: true,
    });
    expect(alpha.rules[1]).toEqual({
      academicYear: '2024/2025',
      chosen: null,
      overrides: [],
      pattern: 'Alpha Course-2024/2025',
      source: 'default',
      valid: true,
    });
  });

  test('records no precedent when the last pattern row supplies no pattern', async () => {
    const base = uniqueDataset();
    const { report } = await reportFor({
      ...base,
      course_enrollment_patterns: [
        ...base.course_enrollment_patterns,
        {
          id: 9,
          course_name: courseNames.alpha,
          academic_year: '2024/2025',
          pattern: '',
        },
      ],
    });

    expect(courseCandidate(report, courseNames.alpha).rules[1]).toEqual({
      academicYear: '2024/2025',
      chosen: null,
      overrides: [9],
      pattern: 'Alpha Course-2024/2025',
      source: 'default',
      valid: true,
    });
    expect(shapes(report, 'invalid_source_row')).toEqual([
      { collection: 'course_enrollment_patterns', ids: [9] },
    ]);
    expect(report.migratable).toBe(false);
  });

  test('counts the same enrollments as the derivation when every rule is frozen as an explicit pattern', async () => {
    const dataset = makeSyntheticDataset();
    const { report } = await reportFor(dataset);
    const frozen = frozenPatterns(report);
    const original = await deriveCourses(toCourseSources(dataset));
    const seeded = await deriveCourses(
      toCourseSources({ ...dataset, course_enrollment_patterns: frozen }),
    );

    expect(frozen).toHaveLength(dataset.courses.length * academicYears.length);

    for (const [index, update] of original.entries()) {
      for (const year of academicYears) {
        expect(seeded[index]?.[enrollmentKey(year)]).toBe(
          update[enrollmentKey(year)],
        );
      }
    }
  });

  test('resolves council members through the first student per index and keeps duplicates unresolved', async () => {
    const dataset = makeSyntheticDataset();
    const { report } = await reportFor(dataset);
    const oracle = deriveStudentCouncil(toCouncilSources(dataset));

    expect(report.candidates.council).toEqual([
      {
        id: 1,
        indexNumber: 'SYN-0001',
        student: {
          label: 'SYN-0001',
          matches: [1, 2],
          precedent: 1,
          resolution: 'ambiguous',
        },
      },
      {
        id: 2,
        indexNumber: 'SYN-9999',
        student: {
          label: 'SYN-9999',
          matches: [],
          precedent: null,
          resolution: 'missing',
        },
      },
      {
        id: 3,
        indexNumber: 'SYN-0002',
        student: {
          label: 'SYN-0002',
          matches: [3],
          precedent: 3,
          resolution: 'unique',
        },
      },
      {
        id: 4,
        indexNumber: 'SYN-0003',
        student: {
          label: 'SYN-0003',
          matches: [4],
          precedent: 4,
          resolution: 'unique',
        },
      },
    ]);

    for (const member of report.candidates.council) {
      const precedentName =
        dataset.students.find((row) => row.id === member.student.precedent)?.[
          'name'
        ] ?? null;
      const expected = oracle.find((row) => row['id'] === member.id)?.['name'];

      expect(precedentName === '' ? null : precedentName).toBe(expected);
    }
  });
});

describe('preflight blockers', () => {
  test('marks the deduplicated synthetic input migratable', async () => {
    const { report } = await reportFor(uniqueDataset());

    expect(report.blockers).toEqual([]);
    expect(report.migratable).toBeTruthy();
    expect(report.version).toBe(migrationVersion);
    expect(report.sourceFingerprint).toMatch(hexPattern);
    expect(report.counts).toEqual({
      collections: {
        course_enrollment_patterns: 3,
        course_equivalencies: 9,
        courses: 8,
        curriculum_2018: 9,
        curriculum_2023: 9,
        deans_office: 2,
        discord_channels: 2,
        moodle_users: 9,
        rooms: 3,
        staff: 3,
        student_council: 4,
        students: 3,
        teaching_assignments: 7,
      },
      flows: 0,
      operations: 0,
    });

    const codes = report.warnings.map(({ code }) => code);

    expect(codes).toContain('orphan_assignment');
    expect(codes).toContain('orphan_pattern');
    expect(codes).toContain('unmatched_council_index');
  });

  test('blocks every active ambiguity of the synthetic input with its precedent recorded', async () => {
    const { report } = await reportFor(makeSyntheticDataset());

    expect(report.migratable).toBe(false);
    expect(
      report.blockers.map(({ code, collection, ids }) => ({
        code,
        collection,
        ids,
      })),
    ).toEqual([
      { code: 'ambiguous_curriculum_2018', collection: 'courses', ids: [1] },
      { code: 'ambiguous_curriculum_2023', collection: 'courses', ids: [1] },
      { code: 'ambiguous_legacy_equivalency', collection: 'courses', ids: [1] },
      {
        code: 'ambiguous_student_index',
        collection: 'student_council',
        ids: [1],
      },
    ]);
    expect(report.blockers.map(({ message }) => message).join('\n')).toContain(
      'first ascending id 1',
    );
  });

  test('keeps a duplicate student index as retained rows and an unresolved council link', async () => {
    const dataset = makeSyntheticDataset();
    const { report } = await reportFor(dataset);
    const council = report.mappings.filter(
      (entry) =>
        entry.sourceCollection === 'student_council' &&
        entry.relation === 'student',
    );

    expect(findings(report, 'duplicate_student_index')).toEqual([
      expect.objectContaining({ collection: 'students', ids: [1, 2] }),
    ]);
    expect(report.counts.collections.students).toBe(dataset.students.length);
    expect(
      council.map(({ sourceId, status, targetId }) => [
        sourceId,
        status,
        targetId,
      ]),
    ).toEqual([
      [1, 'unresolved', null],
      [2, 'unresolved', null],
      [3, 'pending', 3],
      [4, 'pending', 4],
    ]);
    expect(council[0]).toMatchObject({
      targetCollection: 'students',
      targetId: null,
    });
    expect(JSON.stringify(report)).not.toContain(studentName);
  });

  test('blocks a course name or pattern that is not a valid unicode regular expression', async () => {
    const dataset = withMetacharacterCourse(uniqueDataset());
    const { report } = await reportFor({
      ...dataset,
      course_enrollment_patterns: [
        ...dataset.course_enrollment_patterns,
        {
          id: 9,
          course_name: courseNames.beta,
          academic_year: '2020/2021',
          pattern: String.raw`Beta\-2020`,
        },
      ],
    });
    const invalid = findings(report, 'invalid_regex');

    expect(report.migratable).toBe(false);
    expect(shapes(report, 'invalid_regex')).toEqual([
      { collection: 'courses', ids: [2] },
      { collection: 'courses', ids: [99] },
    ]);
    expect(invalid[0]?.message).toContain('2020/2021');
    expect(invalid[1]?.message).toContain(metacharacterCourseName);
    expect(
      courseCandidate(report, metacharacterCourseName).rules.every(
        ({ valid }) => !valid,
      ),
    ).toBeTruthy();
    expect(
      courseCandidate(report, courseNames.beta).rules.find(
        ({ academicYear }) => academicYear === '2020/2021',
      ),
    ).toMatchObject({ chosen: 9, source: 'override', valid: false });
  });

  test('blocks an override whose target curriculum row is missing', async () => {
    const { report } = await reportFor(
      withCourse(uniqueDataset(), courseNames.beta, {
        name_2018_override: 'Nowhere Legacy',
      }),
    );

    expect(report.migratable).toBe(false);
    expect(report.blockers).toEqual([
      expect.objectContaining({
        code: 'missing_override_target',
        collection: 'courses',
        ids: [2],
        label: 'Nowhere Legacy',
      }),
    ]);
    expect(courseCandidate(report, courseNames.beta).legacy).toMatchObject({
      entry: {
        label: 'Nowhere Legacy',
        matches: [],
        precedent: null,
        resolution: 'missing',
      },
      label: 'Nowhere Legacy',
      source: 'override',
    });
  });
});

describe('preflight blockers on duplicate rows', () => {
  test('blocks an ambiguous course name only where a row actively references it', async () => {
    const base = uniqueDataset();
    const { report } = await reportFor({
      ...base,
      courses: [
        ...base.courses,
        { ...base.courses[0], id: 90, name: courseNames.alpha },
      ],
    });

    expect(
      report.blockers.map(({ code, collection, ids }) => ({
        code,
        collection,
        ids,
      })),
    ).toEqual([
      {
        code: 'ambiguous_course_name',
        collection: 'course_enrollment_patterns',
        ids: [1],
      },
      {
        code: 'ambiguous_course_name',
        collection: 'course_equivalencies',
        ids: [1],
      },
      {
        code: 'ambiguous_course_name',
        collection: 'teaching_assignments',
        ids: [1],
      },
    ]);
    expect(shapes(report, 'duplicate_course_name')).toEqual([
      { collection: 'courses', ids: [1, 90] },
    ]);
  });

  test('blocks exact duplicate role rows without naming anyone', async () => {
    const base = uniqueDataset();
    const { report } = await reportFor({
      ...base,
      deans_office: [...base.deans_office, { ...base.deans_office[0], id: 3 }],
      student_council: [
        ...base.student_council,
        { ...base.student_council[2], id: 5 },
      ],
    });
    const duplicates = findings(report, 'duplicate_role_row');

    expect(duplicates).toEqual([
      expect.objectContaining({ collection: 'deans_office', ids: [1, 3] }),
      expect.objectContaining({ collection: 'student_council', ids: [3, 5] }),
    ]);
    expect(JSON.stringify(duplicates)).not.toContain('Synthetic Dean');
  });
});

describe('preflight warnings and mappings', () => {
  test('warns about duplicate assignments and patterns while recording the precedent', async () => {
    const { report } = await reportFor(makeSyntheticDataset());
    const codes = report.blockers.map(({ code }) => code);

    expect(shapes(report, 'duplicate_assignment')).toEqual([
      { collection: 'teaching_assignments', ids: [1, 2] },
    ]);
    expect(shapes(report, 'duplicate_pattern')).toEqual([
      { collection: 'course_enrollment_patterns', ids: [1, 2] },
    ]);
    expect(codes).not.toContain('duplicate_assignment');
    expect(codes).not.toContain('duplicate_pattern');
  });

  test('keeps an unmatched name_2023 as a retained label under review, never a canonical-name fallback', async () => {
    const { report } = await reportFor(
      withCourse(uniqueDataset(), courseNames.alpha, {
        name_2023: 'Nowhere Current',
      }),
    );

    expect(report.blockers).toEqual([]);
    expect(findings(report, 'unmatched_curriculum_2023_label')).toEqual([
      expect.objectContaining({
        collection: 'courses',
        ids: [1],
        label: 'Nowhere Current',
      }),
    ]);
    expect(courseCandidate(report, courseNames.alpha).current).toEqual({
      label: 'Nowhere Current',
      matches: [],
      precedent: null,
      resolution: 'missing',
    });
  });

  test('puts credits or availability of a generation without a label under review and leaves empty ones alone', async () => {
    const { report } = await reportFor(uniqueDataset());
    const { report: emptied } = await reportFor(
      withCourse(uniqueDataset(), courseNames.gamma, { available_2018: null }),
    );
    const { report: credited } = await reportFor(
      withCourse(uniqueDataset(), courseNames.delta, { credits_2023: 6 }),
    );

    expect(report.blockers).toEqual([]);
    expect(findings(report, 'unlinked_generation_values')).toEqual([
      expect.objectContaining({
        collection: 'courses',
        ids: [3],
        label: courseNames.gamma,
      }),
    ]);
    expect(courseCandidate(report, courseNames.gamma).legacy.entry).toEqual(
      expect.objectContaining({ resolution: 'none' }),
    );
    expect(findings(emptied, 'unlinked_generation_values')).toEqual([]);
    expect(
      findings(credited, 'unlinked_generation_values').map(({ ids }) => ids),
    ).toEqual([[3], [4]]);
  });

  test('warns about labels carrying regex or LIKE metacharacters and about orphan rows', async () => {
    const { report } = await reportFor(uniqueDataset());

    expect(findings(report, 'label_metacharacters')).toEqual([
      expect.objectContaining({
        collection: 'courses',
        ids: [8],
        label: courseNames.iota,
      }),
    ]);
    expect(shapes(report, 'orphan_equivalency').map(({ ids }) => ids)).toEqual([
      [3],
      [9],
      [10],
    ]);
    expect(shapes(report, 'orphan_assignment').map(({ ids }) => ids)).toEqual([
      [6],
    ]);
    expect(shapes(report, 'orphan_pattern').map(({ ids }) => ids)).toEqual([
      [4],
    ]);
    expect(shapes(report, 'unreferenced_rows')).toEqual([
      { collection: 'curriculum_2018', ids: [2, 4, 8, 10] },
      { collection: 'curriculum_2023', ids: [3, 10] },
    ]);
  });
});

describe('preflight flows and mappings', () => {
  test('lists persisted Flows and flags the legacy rebuild and publish Flows for cutover review', async () => {
    const store = storeFromDataset(uniqueDataset(), { installed: true });
    store.flows.push(
      {
        id: 'flow-a',
        name: 'Rebuild derived data',
        operation: 'op-a',
        status: 'active',
        trigger: 'manual',
      },
      {
        id: 'flow-b',
        name: 'Synthetic notification',
        operation: null,
        status: 'inactive',
        trigger: 'event',
      },
      {
        id: 'flow-c',
        name: 'Synthetic renamed publisher',
        operation: 'op-c',
        status: 'active',
        trigger: 'manual',
      },
    );
    // The checkpoint Publish public assets Flow writes the four files with
    // the finki-hub-publish-json operation (follow-up 26: the preflight
    // looked for another type and reported it as an ordinary Flow).
    store.operations.push(
      {
        flow: 'flow-a',
        id: 'op-a',
        key: 'rebuild',
        options: {},
        reject: null,
        resolve: null,
        type: 'finki-hub-rebuild-derived-data',
      },
      {
        flow: 'flow-c',
        id: 'op-c',
        key: 'publish_assets',
        options: {},
        reject: null,
        resolve: null,
        type: 'finki-hub-publish-json',
      },
    );
    const report = await reportOf(store);

    expect(report.flows).toEqual([
      {
        id: 'flow-a',
        name: 'Rebuild derived data',
        operationTypes: ['finki-hub-rebuild-derived-data'],
        status: 'active',
        trigger: 'manual',
      },
      {
        id: 'flow-b',
        name: 'Synthetic notification',
        operationTypes: [],
        status: 'inactive',
        trigger: 'event',
      },
      {
        id: 'flow-c',
        name: 'Synthetic renamed publisher',
        operationTypes: ['finki-hub-publish-json'],
        status: 'active',
        trigger: 'manual',
      },
    ]);
    expect(report.counts.flows).toBe(3);
    expect(findings(report, 'legacy_flow_present')).toEqual([
      expect.objectContaining({
        collection: 'directus_flows',
        label: 'flow-a',
      }),
      expect.objectContaining({
        collection: 'directus_flows',
        label: 'flow-c',
      }),
    ]);
    expect(findings(report, 'persisted_flow')).toHaveLength(1);
    expect(report.blockers).toEqual([]);
  });

  test('maps every planned target row and reuses rows that carry provenance', async () => {
    const store = storeFromDataset(uniqueDataset(), { installed: true });
    store.items.get('curriculum_entries')?.push(
      {
        generation: 3,
        id: 7,
        name: 'Beta Course',
        source_collection: 'curriculum_2023',
        source_id: 4,
      },
      {
        generation: 3,
        id: 8,
        name: 'Hand made',
        source_collection: null,
        source_id: null,
      },
    );
    store.items.get('academic_years')?.push({ id: 3, label: '2025/2026' });
    const report = await reportOf(store);
    const entries = report.mappings.filter(
      (entry) =>
        entry.targetCollection === 'curriculum_entries' &&
        entry.relation === 'entry',
    );
    const byTarget = (collection: string) =>
      report.mappings.filter((entry) => entry.targetCollection === collection);

    expect(entries).toHaveLength(18);
    expect(
      entries.find(
        (entry) =>
          entry.sourceId === 4 && entry.sourceCollection === 'curriculum_2023',
      ),
    ).toEqual({
      relation: 'entry',
      sourceCollection: 'curriculum_2023',
      sourceId: 4,
      status: 'existing',
      targetCollection: 'curriculum_entries',
      targetId: 7,
    });
    expect(entries.filter(({ status }) => status === 'pending')).toHaveLength(
      17,
    );
    expect(
      byTarget('academic_years').find(
        (entry) => entry.sourceId === '2025/2026',
      ),
    ).toMatchObject({ status: 'existing', targetId: 3 });
    expect(byTarget('academic_years')).toHaveLength(academicYears.length);
    expect(byTarget('course_enrollment_rules')).toHaveLength(
      8 * academicYears.length,
    );
    expect(byTarget('course_curricula')).toHaveLength(12);
    expect(
      new Set(byTarget('course_curricula').map(({ status }) => status)),
    ).toEqual(new Set(['pending']));
    expect(
      byTarget('course_curricula').every(({ targetId }) => targetId === null),
    ).toBeTruthy();
    expect(findings(report, 'unprovenanced_target_rows')).toEqual([
      expect.objectContaining({ collection: 'curriculum_entries', ids: [8] }),
    ]);
    expect(report.targets).toEqual({
      academic_years: 1,
      course_curricula: 0,
      course_enrollment_rules: 0,
      curriculum_entries: 2,
    });
  });

  test('produces a deterministic report that round-trips through its schema without private data', async () => {
    const first = await reportFor(makeSyntheticDataset());
    const second = await reportFor(makeSyntheticDataset());
    const text = JSON.stringify(first.report);

    expect(second.report).toEqual(first.report);
    expect(migrationReportSchema.parse(JSON.parse(text))).toEqual(first.report);
    expect(text).not.toContain('@');
    expect(text).not.toContain(studentName);
    expect(text).not.toContain('Synthetic Dean');

    for (const sentinel of privateSentinels) {
      expect(text).not.toContain(sentinel);
    }
  });
});
