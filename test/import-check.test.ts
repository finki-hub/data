import { describe, expect, test } from 'vitest';

import type { CourseCandidate } from '../src/import/candidates.js';

import {
  blockerCodes,
  skippedCodes,
  warningCodes,
} from '../src/import/findings.js';
import { planImport } from '../src/import/plan.js';
import {
  expectedCouncil,
  expectedEnrollments,
  expectedRows,
} from './expected-exports.js';
import {
  academicYears,
  courseNames,
  makeSyntheticDataset,
  metacharacterCourseName,
  privateSentinels,
  type SyntheticDataset,
  type SyntheticRow,
  withMetacharacterCourse,
} from './fixtures/synthetic-data.js';
import { lifecycleDataset } from './fixtures/synthetic-workbook.js';
import {
  checkOf,
  codes,
  contentOf,
  findingsOf,
  planOf,
  shapes,
  staffRow,
  uniqueDataset,
  withCourse,
} from './import-plan-helpers.js';
import { matchingHistories } from './relational-export-helpers.js';

const thetaProfessor = 'Prof. Theta';

// The rules of a course, each with the course.
const courseRules = ({ id, rules }: CourseCandidate) =>
  rules.map((rule) => ({ ...rule, course: id }));

// The name of a candidate's course row: a candidate carries the row's
// ordinal, its position in the dataset from 1.
const nameOf = (
  dataset: SyntheticDataset,
  { id }: CourseCandidate,
): string | undefined => {
  const name = dataset.courses[id - 1]?.['name'];
  return typeof name === 'string' ? name : undefined;
};

const courseCandidate = (
  dataset: SyntheticDataset,
  courses: readonly CourseCandidate[],
  name: string,
): CourseCandidate => {
  const candidate = courses.find((course) => nameOf(dataset, course) === name);
  if (candidate === undefined) {
    throw new Error(`No candidate for ${name}`);
  }
  return candidate;
};

// The committed courses.json row of every synthetic course, by its name
// (unique in the dataset). An empty curriculum code is published as no key.
const codeOf = (row: SyntheticRow | undefined): unknown =>
  row?.['code'] === '' ? null : (row?.['code'] ?? null);

const syntheticCourses = await expectedRows('synthetic', 'courses');
const publishedCourses = new Map(
  syntheticCourses.map((row) => [row['name'], row]),
);

describe('the finding codes', () => {
  test('split every code into exactly one of blocking, skipped and warning', () => {
    const all = [...blockerCodes, ...skippedCodes, ...warningCodes];

    expect(new Set(all).size).toBe(all.length);
    expect(blockerCodes).toEqual(
      expect.arrayContaining([
        'duplicate_assignment',
        'unlinked_generation_values',
        'unmatched_curriculum_2018_label',
        'unmatched_curriculum_2023_label',
      ]),
    );
    expect([...skippedCodes]).toEqual([
      'duplicate_pattern',
      'orphan_assignment',
      'orphan_pattern',
      'unknown_academic_year',
    ]);
  });
});

describe('curriculum candidates resolve as the committed files publish them', () => {
  test('resolves 2023 entries through name_2023 with the first matching row', () => {
    const dataset = makeSyntheticDataset();
    const { candidates } = checkOf(dataset);

    for (const course of candidates.courses) {
      const published = publishedCourses.get(nameOf(dataset, course));
      const precedent =
        dataset.curriculum_2023[(course.current.precedent ?? 0) - 1];

      expect(
        codeOf(course.current.precedent === null ? undefined : precedent),
      ).toBe(published?.['2023-code'] ?? null);
    }

    expect(
      courseCandidate(dataset, candidates.courses, courseNames.alpha).current,
    ).toEqual({
      matches: [1, 2],
      precedent: 1,
      resolution: 'ambiguous',
    });
    expect(
      courseCandidate(dataset, candidates.courses, courseNames.delta).current,
    ).toEqual({
      matches: [],
      precedent: null,
      resolution: 'none',
    });
  });

  test('resolves 2018 entries through the override, else the first equivalency, with the first matching row', () => {
    const dataset = makeSyntheticDataset();
    const { candidates } = checkOf(dataset);

    for (const course of candidates.courses) {
      const published = publishedCourses.get(nameOf(dataset, course));
      const precedent =
        course.legacy.entry.precedent === null
          ? undefined
          : dataset.curriculum_2018[course.legacy.entry.precedent - 1];

      expect(precedent?.['name'] ?? null).toBe(
        published?.['2018-name'] ?? null,
      );
      expect(codeOf(precedent)).toBe(published?.['2018-code'] ?? null);
    }

    expect(
      courseCandidate(dataset, candidates.courses, courseNames.alpha).legacy,
    ).toEqual({
      entry: { matches: [1, 9], precedent: 1, resolution: 'ambiguous' },
      equivalencies: { matches: [1, 2], precedent: 1, resolution: 'ambiguous' },
      source: 'equivalency',
    });
    expect(
      courseCandidate(dataset, candidates.courses, courseNames.beta).legacy,
    ).toMatchObject({
      entry: { matches: [3], precedent: 3, resolution: 'unique' },
      source: 'override',
    });
    expect(
      courseCandidate(dataset, candidates.courses, courseNames.gamma).legacy,
    ).toMatchObject({
      entry: { matches: [], precedent: null, resolution: 'none' },
      source: 'none',
    });
  });
});

describe('staff, rule and council candidates', () => {
  test('links staff only through complete labels of an unambiguous delimited text, in the order it names them', () => {
    const dataset = makeSyntheticDataset();
    const { candidates, findings } = checkOf({
      ...dataset,
      staff: [
        ...dataset.staff,
        staffRow(4, 'Prof. Zed Alpha'),
        staffRow(5, 'Prof. Abe Alpha'),
        staffRow(6, 'Asst. Alpha One; Asst. Alpha Two'),
        staffRow(7, thetaProfessor),
        { ...staffRow(8, thetaProfessor), active: false },
      ],
    });
    const staffOf = (id: number) =>
      candidates.assignments.find((row) => row.id === id)?.staff;

    expect(staffOf(1)).toEqual([
      {
        resolution: 'unique',
        role: 'professor',
        staff: [4, 5],
        text: 'Prof. Zed Alpha, Prof. Abe Alpha',
      },
      {
        resolution: 'unique',
        role: 'assistant',
        staff: [6],
        text: 'Asst. Alpha One; Asst. Alpha Two',
      },
    ]);
    expect(staffOf(7)?.[0]).toEqual({
      resolution: 'ambiguous',
      role: 'professor',
      staff: [7, 8],
      text: thetaProfessor,
    });
    expect(shapes(findings, 'ambiguous_staff_label')).toEqual([
      { collection: 'teaching_assignments', ids: [7] },
    ]);
    expect(shapes(findings, 'duplicate_staff_name')).toEqual([
      { collection: 'staff', ids: [7, 8] },
    ]);
  });

  test('reports the staff text of every imported teaching row, never of a row it skips', () => {
    const { candidates, findings } = checkOf(makeSyntheticDataset());
    const textsOf = (id: number) =>
      candidates.assignments
        .find((row) => row.id === id)
        ?.staff.map(({ resolution, role, text }) => [role, text, resolution]);

    expect(textsOf(5)).toEqual([
      ['professor', null, 'none'],
      ['assistant', 'Asst. Zeta', 'unresolved'],
    ]);
    expect(
      shapes(findings, 'unresolved_staff_text').map(({ ids }) => ids[0]),
    ).toEqual([1, 1, 2, 2, 3, 3, 4, 5, 7, 7, 8, 8]);
    expect(shapes(findings, 'orphan_assignment')).toEqual([
      { collection: 'teaching_assignments', ids: [6] },
    ]);
  });

  test('seeds one rule per course and year with the last pattern, else the name-year default', () => {
    const dataset = makeSyntheticDataset();
    const { candidates } = checkOf(dataset);
    const alpha = courseCandidate(
      dataset,
      candidates.courses,
      courseNames.alpha,
    );

    for (const course of candidates.courses) {
      expect(course.rules.map(({ academicYear }) => academicYear)).toEqual([
        ...academicYears,
      ]);
    }

    expect(alpha.rules[0]).toEqual({
      academicYear: '2025/2026',
      overrides: [1, 2],
      pattern: 'Alpha Honors-2025/2026',
      source: 'override',
      valid: true,
    });
    expect(alpha.rules[1]).toEqual({
      academicYear: '2024/2025',
      overrides: [],
      pattern: 'Alpha Course-2024/2025',
      source: 'default',
      valid: true,
    });
  });

  test('the rules count exactly the committed enrollments of the synthetic dataset', async () => {
    const dataset = makeSyntheticDataset();
    const { candidates } = checkOf(dataset);
    const histories = dataset.moodle_users.map((user) => user['Courses']);
    const rules = candidates.courses.flatMap(courseRules);
    const counts = Object.fromEntries(
      rules.map(({ academicYear, course, pattern }) => [
        `${String(course)}/${academicYear}`,
        matchingHistories(pattern, histories),
      ]),
    );

    expect(Object.keys(counts)).toHaveLength(
      dataset.courses.length * academicYears.length,
    );
    expect(counts).toEqual(await expectedEnrollments('synthetic'));
  });

  test('falls back to the default when the last pattern row supplies no pattern', () => {
    const base = uniqueDataset();
    const dataset = {
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
    };
    const { candidates, findings } = checkOf(dataset);

    expect(
      courseCandidate(dataset, candidates.courses, courseNames.alpha).rules[1],
    ).toEqual({
      academicYear: '2024/2025',
      overrides: [4],
      pattern: 'Alpha Course-2024/2025',
      source: 'default',
      valid: true,
    });
    expect(shapes(findings, 'invalid_source_row')).toEqual([
      { collection: 'course_enrollment_patterns', ids: [4] },
    ]);
  });

  test('links council members through the one student of an index, whose name the committed council file carries', async () => {
    const dataset = makeSyntheticDataset();
    const { candidates } = checkOf(dataset);
    const council = await expectedCouncil();

    expect(
      candidates.council.map(({ id, student }) => [id, student.resolution]),
    ).toEqual([
      [1, 'ambiguous'],
      [2, 'missing'],
      [3, 'unique'],
      [4, 'unique'],
    ]);

    for (const member of candidates.council) {
      const name =
        member.student.precedent === null
          ? null
          : (dataset.students[member.student.precedent - 1]?.['name'] ?? null);

      expect(name === '' ? null : name).toBe(
        council.find(({ id }) => id === member.id)?.name,
      );
    }
  });
});

describe('cases that refuse the import', () => {
  test('finds none in the deduplicated dataset once its two cases that change the files are resolved', () => {
    const resolved = withCourse(uniqueDataset(), courseNames.gamma, {
      available_2018: null,
    });
    const plan = planOf(resolved);

    expect(plan.blockers).toEqual([]);
    expect(codes(plan.skipped)).toEqual([
      'orphan_assignment',
      'orphan_pattern',
    ]);
    expect(codes(plan.warnings)).toEqual(
      expect.arrayContaining(['orphan_equivalency', 'unmatched_council_index']),
    );
  });

  test('blocks every ambiguity of the synthetic dataset and each case that would change the published files', () => {
    const plan = planOf(makeSyntheticDataset());

    expect(
      plan.blockers.map(({ code, collection, ids }) => ({
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
      {
        code: 'duplicate_assignment',
        collection: 'teaching_assignments',
        ids: [1, 2],
      },
      { code: 'unlinked_generation_values', collection: 'courses', ids: [3] },
    ]);
  });

  test('blocks exactly the two review items of the lifecycle dataset, the places its committed files differ from the parity ones', () => {
    const plan = planOf(lifecycleDataset());

    expect(
      plan.blockers.map(({ code, collection, ids }) => [code, collection, ids]),
    ).toEqual([
      ['duplicate_assignment', 'teaching_assignments', [1, 2]],
      ['unlinked_generation_values', 'courses', [3]],
    ]);
    expect(codes(plan.skipped)).toEqual([
      'duplicate_pattern',
      'orphan_assignment',
      'orphan_pattern',
    ]);
  });

  test('blocks a name that matches no curriculum row, an override naming none, and credits without a label', () => {
    const base = withCourse(uniqueDataset(), courseNames.gamma, {
      available_2018: null,
    });
    const blocked = (dataset: typeof base) =>
      planOf(dataset).blockers.map(({ code, ids }) => [code, ids]);

    expect(
      blocked(withCourse(base, courseNames.alpha, { name_2023: 'Nowhere' })),
    ).toEqual([['unmatched_curriculum_2023_label', [1]]]);
    expect(
      blocked(
        withCourse(base, courseNames.beta, { name_2018_override: 'Nowhere' }),
      ),
    ).toEqual([['missing_override_target', [2]]]);
    expect(
      blocked({
        ...base,
        course_equivalencies: base.course_equivalencies.map((row) =>
          row['course_2023'] === courseNames.zeta
            ? { ...row, course_2018: 'Nowhere' }
            : row,
        ),
      }),
    ).toEqual([['unmatched_curriculum_2018_label', [6]]]);
    expect(
      blocked(withCourse(base, courseNames.delta, { credits_2023: 6 })),
    ).toEqual([['unlinked_generation_values', [4]]]);
    expect(
      checkOf(withCourse(base, courseNames.alpha, { name_2023: 'Nowhere' }))
        .candidates.courses[0]?.current,
    ).toEqual({
      matches: [],
      precedent: null,
      resolution: 'missing',
    });
  });

  test('blocks a course name or pattern that is not a valid unicode regular expression', () => {
    const dataset = withMetacharacterCourse(uniqueDataset());
    const { candidates, findings } = checkOf({
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

    expect(shapes(findings, 'invalid_regex')).toEqual([
      { collection: 'courses', ids: [2] },
      { collection: 'courses', ids: [9] },
    ]);
    expect(
      courseCandidate(
        dataset,
        candidates.courses,
        metacharacterCourseName,
      ).rules.every(({ valid }) => !valid),
    ).toBeTruthy();
    expect(
      courseCandidate(dataset, candidates.courses, courseNames.beta).rules.find(
        ({ academicYear }) => academicYear === '2020/2021',
      ),
    ).toMatchObject({
      overrides: [4],
      pattern: String.raw`Beta\-2020`,
      source: 'override',
      valid: false,
    });
  });

  test('blocks an ambiguous course name only where a row references it', () => {
    const base = uniqueDataset();
    const [alpha] = base.courses;
    const { findings } = checkOf({
      ...base,
      courses: [...base.courses, { ...alpha, id: 90, name: courseNames.alpha }],
    });

    expect(
      findings
        .filter(({ code }) => code === 'ambiguous_course_name')
        .map(({ collection, ids }) => [collection, ids]),
    ).toEqual([
      ['course_enrollment_patterns', [1]],
      ['course_equivalencies', [1]],
      ['teaching_assignments', [1]],
    ]);
    expect(shapes(findings, 'duplicate_course_name')).toEqual([
      { collection: 'courses', ids: [1, 9] },
    ]);
  });

  test('blocks exact duplicate council and dean rows without naming anyone', () => {
    const base = uniqueDataset();
    const { findings } = checkOf({
      ...base,
      deans_office: [...base.deans_office, { ...base.deans_office[0], id: 3 }],
      student_council: [
        ...base.student_council,
        { ...base.student_council[2], id: 5 },
      ],
    });

    expect(shapes(findings, 'duplicate_role_row')).toEqual([
      { collection: 'deans_office', ids: [1, 3] },
      { collection: 'student_council', ids: [3, 5] },
    ]);
  });
});

describe('rows the import skips and warnings', () => {
  test('skips the earlier of two patterns of one course and year, and orphan rows', () => {
    expect(
      planOf(makeSyntheticDataset()).skipped.map(
        ({ code, collection, ids }) => [code, collection, ids],
      ),
    ).toEqual([
      ['duplicate_pattern', 'course_enrollment_patterns', [1]],
      ['orphan_assignment', 'teaching_assignments', [6]],
      ['orphan_pattern', 'course_enrollment_patterns', [4]],
    ]);
  });

  test('skips a pattern of a year the academic years of the workbook lack', () => {
    const base = makeSyntheticDataset();
    const content = contentOf({
      ...base,
      course_enrollment_patterns: [
        ...base.course_enrollment_patterns,
        {
          id: 5,
          course_name: courseNames.beta,
          academic_year: '2010/2011',
          pattern: 'Beta Course-2010/2011',
        },
      ],
    });
    const plan = planImport({ ...content, academicYears });

    expect(
      plan.skipped
        .filter(({ code }) => code === 'unknown_academic_year')
        .map(({ collection, ids }) => [collection, ids]),
    ).toEqual([['course_enrollment_patterns', [5]]]);
  });

  test('warns about metacharacters, orphan equivalencies and curriculum rows no course names', () => {
    const findings = findingsOf(planOf(uniqueDataset()));

    expect(shapes(findings, 'label_metacharacters')).toEqual([
      { collection: 'courses', ids: [8] },
    ]);
    expect(
      shapes(findings, 'orphan_equivalency').map(({ ids }) => ids),
    ).toEqual([[2], [8], [9]]);
    expect(shapes(findings, 'unreferenced_rows')).toEqual([
      { collection: 'curriculum_2018', ids: [2, 4, 8, 9] },
      { collection: 'curriculum_2023', ids: [2, 9] },
    ]);
  });

  test('warns about an equivalency label naming several entries or none, and an index several students share', () => {
    const { warnings } = planOf(makeSyntheticDataset());
    const unique = planOf(uniqueDataset()).warnings;

    expect(shapes(warnings, 'ambiguous_equivalency_entry')).toEqual([
      { collection: 'course_equivalencies', ids: [1] },
      { collection: 'course_equivalencies', ids: [3] },
    ]);
    expect(shapes(warnings, 'unmatched_equivalency_entry')).toEqual([
      { collection: 'course_equivalencies', ids: [3] },
      { collection: 'course_equivalencies', ids: [9] },
    ]);
    expect(shapes(warnings, 'duplicate_student_index')).toEqual([
      { collection: 'students', ids: [1, 2] },
    ]);
    expect(shapes(unique, 'unmatched_equivalency_entry')).toEqual([
      { collection: 'course_equivalencies', ids: [2] },
      { collection: 'course_equivalencies', ids: [8] },
    ]);
    expect(shapes(unique, 'ambiguous_equivalency_entry')).toEqual([]);
    expect(shapes(unique, 'duplicate_student_index')).toEqual([]);
  });

  test('carries codes, parts and row ordinals only, never a value of the workbook', () => {
    const text = JSON.stringify(findingsOf(planOf(makeSyntheticDataset())));

    expect(planOf(makeSyntheticDataset())).toEqual(
      planOf(makeSyntheticDataset()),
    );
    expect(text).not.toContain('@');
    expect(text).not.toContain('Synthetic');
    expect(text).not.toContain(courseNames.alpha);

    for (const sentinel of privateSentinels) {
      expect(text).not.toContain(sentinel);
    }
  });
});
