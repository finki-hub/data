import { describe, expect, test } from 'vitest';

import type { CourseCandidate } from '../src/import/candidates.js';

import { refusalLines } from '../src/import-report.js';
import {
  blockerCodes,
  ruleFixCodes,
  skippedCodes,
  warningCodes,
} from '../src/import/findings.js';
import { planImport } from '../src/import/plan.js';
import { expectedCouncil, expectedRows } from './expected-exports.js';
import {
  academicYears,
  courseNames,
  makeSyntheticDataset,
  metacharacterCourseName,
  privateSentinels,
  staffNames,
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

const thetaProfessor = 'Prof. Theta';

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
        'unlinked_generation_values',
        'unmatched_curriculum_2018_label',
        'unmatched_curriculum_2023_label',
      ]),
    );
    // What a rule fixes is a warning, never a blocker.
    expect([...ruleFixCodes]).toEqual([
      'duplicate_assignment',
      'duplicate_course_channel',
      'formula_pattern_cell',
      'newest_year_widened',
      'pattern_line_break',
      'repeated_staff_name',
      'unlinked_availability',
    ]);
    expect(warningCodes).toEqual(expect.arrayContaining([...ruleFixCodes]));
    expect([...skippedCodes]).toEqual([
      'duplicate_pattern',
      'merged_pattern',
      'orphan_assignment',
      'orphan_pattern',
      'redundant_pattern',
      'superseded_assignment',
      'unknown_academic_year',
    ]);
    // A teaching line no staff row or several carry, and assistants of an
    // Inactive course, block; the old literal-text codes are gone.
    expect(blockerCodes).toEqual(
      expect.arrayContaining([
        'ambiguous_staff_name',
        'inactive_course_assistants',
        'unmatched_staff_name',
      ]),
    );
    expect(all).not.toContain('unresolved_staff_text');
    expect(all).not.toContain('ambiguous_staff_label');
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

// A staff link of a teaching cell.
const link = (role: string, staff: number, line: number) => ({
  line,
  role,
  staff,
});

describe('teaching candidates', () => {
  test('decides the status and staff links of every course from its typed export row, else its first teaching row', () => {
    const dataset = makeSyntheticDataset();
    const { candidates } = checkOf(dataset);
    const teachingOf = (name: string) =>
      courseCandidate(dataset, candidates.courses, name).teaching;

    expect(teachingOf(courseNames.alpha)).toEqual({
      links: [
        link('professor', 3, 1),
        link('professor', 1, 2),
        link('assistant', 2, 1),
      ],
      source: { id: 1, source: 'teaching_assignments' },
      status: 'active',
    });
    // Typed export cells win: Beta's teaching row 3 is not read.
    expect(teachingOf(courseNames.beta)).toEqual({
      links: [link('professor', 1, 1)],
      source: { id: 2, source: 'courses' },
      status: 'active',
    });
    expect(teachingOf(courseNames.epsilon)).toMatchObject({
      links: [],
      source: { id: 5, source: 'courses' },
      status: 'all_professors',
    });
    expect(teachingOf(courseNames.zeta)).toEqual({
      links: [link('assistant', 3, 1)],
      source: { id: 5, source: 'teaching_assignments' },
      status: 'all_professors',
    });
    expect(teachingOf(courseNames.delta)).toEqual({
      links: [],
      source: { id: 9, source: 'teaching_assignments' },
      status: 'inactive',
    });
    // Theta's empty typed cell is no typed cell.
    expect(teachingOf(courseNames.theta).source).toEqual({
      id: 7,
      source: 'teaching_assignments',
    });
  });

  test('reports the teaching cells of every course it reads, never of a row it skips or ignores', () => {
    const { findings } = checkOf(makeSyntheticDataset());
    const teaching = findings.filter(
      ({ collection }) => collection === 'teaching_assignments',
    );

    // Rows 3 and 4 are superseded by typed export cells, row 2 is a later
    // row of Alpha and row 6 names no course: their unmatched names are not
    // checked.
    // The findings come sorted by code, part and row.
    expect(teaching.map(({ code, ids }) => [code, ids[0]])).toEqual([
      ['duplicate_assignment', 2],
      ['orphan_assignment', 6],
      ['repeated_staff_name', 8],
      ['superseded_assignment', 3],
      ['superseded_assignment', 4],
    ]);
    expect(teaching.find(({ code }) => code === 'repeated_staff_name')).toEqual(
      {
        code: 'repeated_staff_name',
        collection: 'teaching_assignments',
        field: 'professors',
        ids: [8],
        lines: [3],
        related: [{ collection: 'courses', ids: [8] }],
      },
    );
    expect(
      teaching.find(({ code }) => code === 'superseded_assignment'),
    ).toEqual({
      code: 'superseded_assignment',
      collection: 'teaching_assignments',
      ids: [3],
      related: [{ collection: 'courses', ids: [2] }],
    });
  });

  test('blocks an ambiguous staff name and names the staff rows in contention', () => {
    const dataset = makeSyntheticDataset();
    const { findings } = checkOf({
      ...dataset,
      staff: [
        ...dataset.staff,
        staffRow(4, thetaProfessor),
        { ...staffRow(5, thetaProfessor), active: false },
      ],
      teaching_assignments: dataset.teaching_assignments.map((row) =>
        row.id === 7 ? { ...row, assistants: thetaProfessor } : row,
      ),
    });

    expect(
      findings.filter(({ code }) => code === 'ambiguous_staff_name'),
    ).toEqual([
      {
        code: 'ambiguous_staff_name',
        collection: 'teaching_assignments',
        field: 'assistants',
        ids: [7],
        lines: [1],
        related: [
          { collection: 'courses', ids: [7] },
          { collection: 'staff', ids: [4, 5] },
        ],
      },
    ]);
    expect(shapes(findings, 'duplicate_staff_name')).toEqual([
      { collection: 'staff', ids: [4, 5] },
    ]);
  });
});

describe('typed pattern and council candidates', () => {
  test('records the typed pattern of every course and year, the last of its rows, else none', () => {
    const dataset = makeSyntheticDataset();
    const { candidates } = checkOf(dataset);
    const alpha = courseCandidate(
      dataset,
      candidates.courses,
      courseNames.alpha,
    );

    for (const course of candidates.courses) {
      expect(course.patterns.map(({ academicYear }) => academicYear)).toEqual([
        ...academicYears,
      ]);
    }

    expect(alpha.patterns[0]).toEqual({
      academicYear: '2025/2026',
      overrides: [1, 2],
      pattern: 'Alpha Honors-2025/2026',
      valid: true,
    });
    expect(alpha.patterns[1]).toEqual({
      academicYear: '2024/2025',
      overrides: [],
      pattern: null,
      valid: true,
    });
  });

  test('records no typed pattern when the last pattern row supplies none', () => {
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
      courseCandidate(dataset, candidates.courses, courseNames.alpha)
        .patterns[1],
    ).toEqual({
      academicYear: '2024/2025',
      overrides: [4],
      pattern: null,
      valid: true,
    });
    expect(shapes(findings, 'invalid_source_row')).toEqual([
      { collection: 'course_enrollment_patterns', ids: [4] },
    ]);
  });

  // Its standard mapping escapes the name (defaultPattern), so the name is
  // no pattern of its own.
  test('imports a course whose name is no regular expression without a finding', () => {
    const base = uniqueDataset();
    const dataset = withMetacharacterCourse(base);
    const course = courseCandidate(
      dataset,
      checkOf(dataset).candidates.courses,
      metacharacterCourseName,
    );

    expect(codes(findingsOf(planOf(dataset)))).toEqual(
      codes(findingsOf(planOf(base))),
    );
    expect(
      course.patterns.every(({ pattern, valid }) => pattern === null && valid),
    ).toBeTruthy();
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
  test('finds none in the deduplicated dataset, whose FALSE 2018 availability without a 2018 name holds no value', () => {
    const plan = planOf(uniqueDataset());

    expect(plan.blockers).toEqual([]);
    // Alpha's one typed 2025/2026 cell counts what its standard mapping
    // counts that year.
    expect(codes(plan.skipped)).toEqual([
      'orphan_assignment',
      'orphan_pattern',
      'redundant_pattern',
      'superseded_assignment',
      'superseded_assignment',
    ]);
    expect(codes(plan.warnings)).toEqual(
      expect.arrayContaining([
        'orphan_equivalency',
        'repeated_staff_name',
        'unmatched_council_index',
      ]),
    );
  });

  test('blocks every ambiguity of the synthetic dataset', () => {
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
    ]);
  });

  test('imports the lifecycle dataset with the first teaching row of Alpha, the second ignored with a warning, and its FALSE 2018 availability without a 2018 name as no case', () => {
    const plan = planOf(lifecycleDataset());

    expect(plan.blockers).toEqual([]);
    expect(
      plan.warnings.filter(({ code }) => code === 'duplicate_assignment'),
    ).toEqual([
      {
        code: 'duplicate_assignment',
        collection: 'teaching_assignments',
        ids: [2],
        related: [
          { collection: 'courses', ids: [1] },
          { collection: 'teaching_assignments', ids: [1] },
        ],
      },
    ]);
    expect(codes(plan.warnings)).not.toContain('unlinked_availability');
    expect(codes(plan.skipped)).toEqual([
      'duplicate_pattern',
      'orphan_assignment',
      'orphan_pattern',
      'superseded_assignment',
      'superseded_assignment',
    ]);
  });

  test('blocks a name that matches no curriculum row, an override naming none, and credits without a label', () => {
    const base = uniqueDataset();
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

  test('blocks a typed pattern that is not a valid unicode regular expression without its line breaks', () => {
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
        // Compiles only without its pasted line break, as its mapping holds
        // it.
        {
          id: 10,
          course_name: courseNames.beta,
          academic_year: '2019/2020',
          pattern: 'Beta{1,\n2}-2019',
        },
      ],
    });
    const beta = courseCandidate(dataset, candidates.courses, courseNames.beta);

    expect(
      findings
        .filter(({ code }) => code === 'invalid_regex')
        .map(({ collection, ids, related }) => ({ collection, ids, related })),
    ).toEqual([
      {
        collection: 'courses',
        ids: [2],
        related: [{ collection: 'course_enrollment_patterns', ids: [4] }],
      },
    ]);
    expect(
      beta.patterns.find(({ academicYear }) => academicYear === '2020/2021'),
    ).toEqual({
      academicYear: '2020/2021',
      overrides: [4],
      pattern: String.raw`Beta\-2020`,
      valid: false,
    });
    expect(
      beta.patterns.find(({ academicYear }) => academicYear === '2019/2020'),
    ).toMatchObject({ overrides: [5], valid: true });
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

  test('blocks a council row repeating a year, person and position, and a dean row repeating a year and position, without naming anyone', () => {
    const base = uniqueDataset();
    const { findings } = checkOf({
      ...base,
      deans_office: [
        ...base.deans_office,
        // Another holder of the first term.
        { ...base.deans_office[0], id: 3, name: staffNames.inactive },
        // The first holder again, in another position.
        { ...base.deans_office[0], id: 4, position: 'Продекан за финансии' },
      ],
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

describe("the staff member of a dean's office row", () => {
  test('blocks a dean row whose name no staff row or several staff rows carry, and links the others', () => {
    const base = uniqueDataset();
    const twin = 'Synthetic Staff Twin';
    const { candidates, findings } = checkOf({
      ...base,
      deans_office: [
        ...base.deans_office,
        {
          id: 3,
          name: 'Synthetic Staff Nobody',
          position: 'Декан',
          year: 2_023,
        },
        { id: 4, name: twin, position: 'Продекан за настава', year: 2_023 },
      ],
      staff: [...base.staff, staffRow(4, twin), staffRow(5, twin)],
    });
    const deanCases = findings.filter(
      ({ collection }) => collection === 'deans_office',
    );

    expect(deanCases).toEqual([
      {
        code: 'ambiguous_staff_name',
        collection: 'deans_office',
        ids: [4],
        related: [{ collection: 'staff', ids: [4, 5] }],
      },
      { code: 'unmatched_staff_name', collection: 'deans_office', ids: [3] },
    ]);
    expect(candidates.deans).toEqual([
      { id: 1, staff: 1 },
      { id: 2, staff: 3 },
    ]);
  });
});

// The curriculum rows with the codes given by row name.
const coded = (
  rows: readonly SyntheticRow[],
  byName: ReadonlyMap<string, null | string>,
): readonly SyntheticRow[] =>
  rows.map((row) => {
    const code = byName.get(String(row['name']));
    return code === undefined ? row : { ...row, code };
  });

describe('a curriculum code that gives no level', () => {
  test('blocks every non-empty code without the F<yy>L<level> start, one case per row, linked or not, and passes an empty or missing code', () => {
    const base = uniqueDataset();
    const plan = planOf({
      ...base,
      curriculum_2018: coded(
        base.curriculum_2018,
        new Map([
          ['Orphan Legacy Course', 'SYN18-ORPHAN'],
          ['Zeta Legacy', null],
        ]),
      ),
      curriculum_2023: coded(
        base.curriculum_2023,
        new Map([
          [courseNames.beta, 'f23L2W002'],
          [courseNames.gamma, 'F23L1S003'],
        ]),
      ),
    });

    expect(blockerCodes).toContain('curriculum_code_without_level');
    expect(
      plan.blockers.map(({ code, collection, ids }) => [code, collection, ids]),
    ).toEqual([
      ['curriculum_code_without_level', 'curriculum_2018', [8]],
      ['curriculum_code_without_level', 'curriculum_2023', [3]],
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
      ['superseded_assignment', 'teaching_assignments', [3]],
      ['superseded_assignment', 'teaching_assignments', [4]],
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

  test('warns about orphan equivalencies and curriculum rows no course names', () => {
    const findings = findingsOf(planOf(uniqueDataset()));

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

describe('values a required column cannot hold', () => {
  test('reports an empty staff title, position or email and an empty room type as unstorable, by sheet, row and column, never the value', () => {
    const base = uniqueDataset();
    const content = contentOf({
      ...base,
      rooms: base.rooms.map((row) =>
        row.id === 2 ? { ...row, type: null } : row,
      ),
      staff: base.staff.map((row) =>
        row.id === 1
          ? { ...row, email: null, position: null, title: null }
          : row,
      ),
    });
    const plan = planImport(content);
    const lines = refusalLines(plan, content);

    expect(lines).toEqual([
      '- [unstorable] Кадар (Export) row 2, staff.title: empty (required)',
      '- [unstorable] Кадар (Export) row 2, staff.position: empty (required)',
      '- [unstorable] Кадар (Export) row 2, staff.email: empty (required)',
      '- [unstorable] Простории (Export) row 3, rooms.type: empty (required)',
    ]);
    expect(lines.join('\n')).not.toContain('Synthetic');
    expect(planOf(base).unstorable).toEqual([]);
  });
});
