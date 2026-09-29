import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { refusalLines } from '../src/import-report.js';
import { entryKey } from '../src/import/curricula.js';
import { countByCode } from '../src/import/findings.js';
import { type ImportPlan, planImport } from '../src/import/plan.js';
import { compositeKey, ref } from '../src/import/planned.js';
import { readWorkbookContent } from '../src/workbook.js';
import {
  courseNames,
  makeSyntheticDataset,
  type SyntheticDataset,
  type SyntheticRow,
  withMetacharacterCourse,
} from './fixtures/synthetic-data.js';
import { reloaded, syntheticWorkbook } from './fixtures/synthetic-workbook.js';
import {
  contentOf,
  planOf,
  rowsIn,
  uniqueDataset,
  withCourse,
} from './import-plan-helpers.js';
import { parityDataset } from './relational-export-helpers.js';

type Sheet = 'curriculum_2018' | 'curriculum_2023';

// What the import makes of the workbook written from a dataset, read back
// through the workbook readers: its plan and its refusal lines.
const readBack = async (dataset: SyntheticDataset) => {
  const workbook = await reloaded(syntheticWorkbook(dataset));
  const content = readWorkbookContent(workbook);
  const plan = planImport(content);
  return {
    // The merged ranges of the 2023 curriculum sheet.
    blocks: workbook.getWorksheet('Предмети - 2023')?.model.merges ?? [],
    content,
    lines: refusalLines(plan, content),
    plan,
  };
};

// The refusal lines of a dataset, as the import reads it in dataset order.
const linesOf = (dataset: SyntheticDataset): readonly string[] => {
  const content = contentOf(dataset);
  return refusalLines(planImport(content), content);
};

const semesterOf = (row: SyntheticRow | undefined): number =>
  typeof row?.['semester'] === 'number' ? row['semester'] : 0;

// A curriculum sheet laid out as the real ones are: ordered by semester,
// one block per semester whose label (column A, merged over the block) is
// on its first row only.
const inBlocks = (rows: readonly SyntheticRow[]): readonly SyntheticRow[] =>
  rows
    .toSorted((left, right) => semesterOf(left) - semesterOf(right))
    .map((row, index, sorted) => ({
      ...row,
      catalog_order:
        index > 0 && semesterOf(sorted[index - 1]) === semesterOf(row)
          ? null
          : semesterOf(row),
    }));

// The dataset with the subject of a curriculum name listed a second time,
// in the block of a later semester that another program takes it in: the
// program columns note the semester (`задолжителен (сем. 5)`), and the
// listing carries the given code.
const listedTwice = (
  dataset: SyntheticDataset,
  {
    code,
    name,
    semester,
    sheet,
  }: {
    readonly code: null | string;
    readonly name: string;
    readonly semester: number;
    readonly sheet: Sheet;
  },
): SyntheticDataset => {
  const rows = dataset[sheet];
  const first = rows.find((row) => row['name'] === name);
  if (first === undefined) {
    throw new Error(`${sheet} lists no ${name}`);
  }
  const noted = {
    ...first,
    state_kn: `задолжителен (сем. ${String(semesterOf(first))})`,
  };
  return {
    ...dataset,
    [sheet]: inBlocks([
      ...rows.map((row) => (row === first ? noted : row)),
      {
        ...first,
        code,
        id: 100,
        semester,
        state_kn: null,
        state_siis: `задолжителен (сем. ${String(semester)})`,
      },
    ]),
  };
};

// Both curriculum sheets in semester blocks, Beta's 2023 subject (third
// semester) listed again in the fifth-semester block and Epsilon's 2018
// subject (sixth semester, its name given by an equivalency row) in the
// seventh, each second listing with the given code.
const semesterBlocks = (
  codes: { readonly current: null | string; readonly legacy: null | string },
  base = parityDataset(),
): SyntheticDataset =>
  listedTwice(
    listedTwice(base, {
      code: codes.current,
      name: courseNames.beta,
      semester: 5,
      sheet: 'curriculum_2023',
    }),
    {
      code: codes.legacy,
      name: 'Epsilon Legacy',
      semester: 7,
      sheet: 'curriculum_2018',
    },
  );

// A reference to the entry of a curriculum row.
const entry = (sheet: Sheet, ordinal = 0) =>
  ref('curriculum_entries', entryKey(sheet, ordinal));

// The entry a planned row links to.
const entryOf = (
  plan: ImportPlan,
  collection: 'course_curricula' | 'course_equivalency_members',
  key: string,
): unknown =>
  rowsIn(plan, collection).find((row) => row.key === key)?.record['entry'];

// The ordinals of a part's rows whose column holds a value, in sheet order.
const ordinalsOf = (
  rows: readonly SyntheticRow[],
  column: string,
  value: string,
) => rows.flatMap((row, index) => (row[column] === value ? [index + 1] : []));

describe('a subject a curriculum sheet lists in several semester blocks', () => {
  test('links the course and the equivalency member to the first listing when every listing carries the code, with no finding, and imports every listing', async () => {
    const dataset = semesterBlocks({
      current: 'SYN23-002',
      legacy: 'SYN18-005',
    });
    const { blocks, content, lines, plan } = await readBack(dataset);
    const parity = planOf(parityDataset());
    const [beta, betaAgain] = ordinalsOf(
      dataset.curriculum_2023,
      'name',
      courseNames.beta,
    );
    const [epsilon] = ordinalsOf(
      dataset.curriculum_2018,
      'name',
      'Epsilon Legacy',
    );
    const course = (name: string) =>
      ordinalsOf(dataset.courses, 'name', name)[0] ?? 0;
    const equivalency = (name: string) =>
      ordinalsOf(dataset.course_equivalencies, 'course_2023', name)[0] ?? 0;

    expect([beta, betaAgain]).toEqual([5, 8]);
    // Column A is merged over each block of more than one row, and every
    // row of a block reads the block's label.
    expect(new Set(blocks)).toEqual(new Set(['A2:A4', 'A8:A9']));
    expect(
      content.data.curriculum_2023.map((row) => row['catalog_order']),
    ).toEqual([1, 1, 1, 2, 3, 4, 5, 5, 6, 8]);
    expect(plan.blockers).toEqual([]);
    expect(lines).toEqual([]);
    expect(countByCode(plan.warnings)).toEqual(countByCode(parity.warnings));
    expect(rowsIn(plan, 'curriculum_entries')).toHaveLength(
      rowsIn(parity, 'curriculum_entries').length + 2,
    );
    expect(
      entryOf(
        plan,
        'course_curricula',
        compositeKey(course(courseNames.beta), '2023'),
      ),
    ).toEqual(entry('curriculum_2023', beta));
    expect(
      entryOf(
        plan,
        'course_curricula',
        compositeKey(course(courseNames.epsilon), '2018'),
      ),
    ).toEqual(entry('curriculum_2018', epsilon));
    expect(
      entryOf(
        plan,
        'course_equivalency_members',
        compositeKey(equivalency(courseNames.beta), '2023'),
      ),
    ).toEqual(entry('curriculum_2023', beta));
    expect(
      entryOf(
        plan,
        'course_equivalency_members',
        compositeKey(equivalency(courseNames.epsilon), '2018'),
      ),
    ).toEqual(entry('curriculum_2018', epsilon));
  });

  test('refuses listings with different codes, naming the course, the rows and the codes', async () => {
    const { lines, plan } = await readBack(
      semesterBlocks({ current: 'SYN23-009', legacy: 'SYN18-009' }),
    );

    expect(countByCode(plan.blockers)).toEqual({
      ambiguous_curriculum_2018: 1,
      ambiguous_curriculum_2023: 1,
    });
    expect(lines).toEqual([
      '- [ambiguous_curriculum_2018] «Epsilon Course» (Предмети (Export) row 6): its 2018 name «Epsilon Legacy», taken from Еквиваленции row 6, matches rows 7 and 9 of Предмети - 2018, which carry different codes (row 7: «SYN18-005», row 9: «SYN18-009»); give each subject its own name.',
      '- [ambiguous_curriculum_2023] «Beta Course» (Предмети (Export) row 3): its 2023 name matches rows 6 and 9 of Предмети - 2023, which carry different codes (row 6: «SYN23-002», row 9: «SYN23-009»); give each subject its own name.',
    ]);
    expect(countByCode(plan.warnings)).toMatchObject({
      ambiguous_equivalency_entry: 2,
    });
  });

  test('are refused as the README example shows, with the other cases of the workbook', async () => {
    const readme = await readFile(
      path.resolve(import.meta.dirname, '..', 'README.md'),
      'utf8',
    );
    const dataset = semesterBlocks(
      { current: 'SYN23-009', legacy: 'SYN18-005' },
      withCourse(
        parityDataset({ duplicateAssignment: true }),
        courseNames.gamma,
        {
          available_2018: true,
        },
      ),
    );
    const { lines } = await readBack(dataset);

    expect(lines).toEqual([
      '- [ambiguous_curriculum_2023] «Beta Course» (Предмети (Export) row 3): its 2023 name matches rows 6 and 9 of Предмети - 2023, which carry different codes (row 6: «SYN23-002», row 9: «SYN23-009»); give each subject its own name.',
      '- [duplicate_assignment] «Alpha Course» (Предмети (Export) row 2): Наставен Кадар rows 2 and 3 both name it; keep one teaching row per course.',
      '- [unlinked_generation_values] Предмети (Export) row 4 «Gamma Course»: 2018 available is TRUE but the 2018 name is empty; fill in the 2018 name or set available to FALSE.',
    ]);

    for (const line of lines) {
      expect(readme).toContain(`   ${line}\n`);
    }
  });

  test('refuses listings of which one carries no code', async () => {
    const { lines } = await readBack(
      semesterBlocks({ current: null, legacy: 'SYN18-005' }),
    );

    expect(lines).toEqual([
      '- [ambiguous_curriculum_2023] «Beta Course» (Предмети (Export) row 3): its 2023 name matches rows 6 and 9 of Предмети - 2023, which do not all carry a code (row 6: «SYN23-002», row 9: no code); fill in the missing code if they list one subject, or give each subject its own name.',
    ]);
  });

  test('refuses listings whose codes differ only by a space, quoting each code so the space shows', async () => {
    const { lines } = await readBack(
      semesterBlocks({ current: 'SYN23-002 ', legacy: 'SYN18-005' }),
    );

    expect(lines).toEqual([
      '- [ambiguous_curriculum_2023] «Beta Course» (Предмети (Export) row 3): its 2023 name matches rows 6 and 9 of Предмети - 2023, which carry different codes (row 6: «SYN23-002», row 9: «SYN23-002 »); give each subject its own name.',
    ]);
  });
});

describe('curriculum values of a generation the course has no name for', () => {
  test('imports an availability of FALSE alone as no value: no finding and no link', () => {
    const dataset = parityDataset({ gammaAvailability: true });
    const plan = planOf(dataset);

    expect(dataset.courses[2]).toMatchObject({
      available_2018: false,
      credits_2018: null,
      name: courseNames.gamma,
    });
    expect(
      [...plan.blockers, ...plan.warnings].map(({ code }) => code),
    ).not.toContain('unlinked_generation_values');
    expect(plan.blockers).toEqual([]);
    expect(
      rowsIn(plan, 'course_curricula').map(({ key }) => key),
    ).not.toContain(compositeKey(3, '2018'));
    expect(rowsIn(plan, 'course_curricula').map(({ key }) => key)).toContain(
      compositeKey(3, '2023'),
    );
  });

  test('refuses an availability of TRUE or credits without the name, and says which', () => {
    const base = parityDataset();

    expect(
      linesOf(withCourse(base, courseNames.gamma, { available_2018: true })),
    ).toEqual([
      '- [unlinked_generation_values] Предмети (Export) row 4 «Gamma Course»: 2018 available is TRUE but the 2018 name is empty; fill in the 2018 name or set available to FALSE.',
    ]);
    expect(
      linesOf(
        withCourse(base, courseNames.gamma, {
          available_2018: false,
          credits_2018: 6,
        }),
      ),
    ).toEqual([
      '- [unlinked_generation_values] Предмети (Export) row 4 «Gamma Course»: 2018 credits are 6 but the 2018 name is empty; fill in the 2018 name or clear the credits.',
    ]);
    expect(
      linesOf(
        withCourse(base, courseNames.delta, {
          available_2023: true,
          credits_2023: 6,
        }),
      ),
    ).toEqual([
      '- [unlinked_generation_values] Предмети (Export) row 5 «Delta Course»: 2023 credits are 6 and 2023 available is TRUE but the 2023 name is empty; fill in the 2023 name or clear the credits and set available to FALSE.',
    ]);
  });
});

const withPatterns = (
  dataset: SyntheticDataset,
  rows: readonly SyntheticRow[],
): SyntheticDataset => ({
  ...dataset,
  course_enrollment_patterns: [...dataset.course_enrollment_patterns, ...rows],
});

describe('the refusal lines', () => {
  test('explain the ambiguities of the synthetic dataset in plain words, each with its code, course and rows', () => {
    expect(linesOf(makeSyntheticDataset())).toEqual([
      '- [ambiguous_curriculum_2018] «Alpha Course» (Предмети (Export) row 2): its 2018 name «Alpha Legacy», taken from Еквиваленции row 2, matches rows 2 and 10 of Предмети - 2018, which carry different codes (row 2: «SYN18-001», row 10: «SYN18-001-LATER»); give each subject its own name.',
      '- [ambiguous_curriculum_2023] «Alpha Course» (Предмети (Export) row 2): its 2023 name «Alpha Course (2023)» matches rows 2 and 3 of Предмети - 2023, which carry different codes (row 2: «SYN23-001», row 3: «SYN23-001-DUP»); give each subject its own name.',
      '- [ambiguous_legacy_equivalency] «Alpha Course» (Предмети (Export) row 2): Еквиваленции rows 2 and 3 give it different 2018 names («Alpha Legacy» and «Alpha Legacy Duplicate»); make them agree, or fill in its 2018-name to choose one.',
      '- [ambiguous_student_index] ФСС row 2: several students carry its index (Индекси - Година, Индекси - Други rows 2 and 3); correct the index, or keep one student row for it.',
      '- [duplicate_assignment] «Alpha Course» (Предмети (Export) row 2): Наставен Кадар rows 2 and 3 both name it; keep one teaching row per course.',
    ]);
  });

  test('explain names that match no curriculum row', () => {
    const base = parityDataset();

    expect(
      linesOf(withCourse(base, courseNames.alpha, { name_2023: 'Nowhere' })),
    ).toEqual([
      '- [unmatched_curriculum_2023_label] «Alpha Course» (Предмети (Export) row 2): its 2023 name «Nowhere» matches no row of Предмети - 2023; correct it to the name of a 2023 subject.',
    ]);
    expect(
      linesOf(
        withCourse(base, courseNames.beta, { name_2018_override: 'Nowhere' }),
      ),
    ).toEqual([
      '- [missing_override_target] «Beta Course» (Предмети (Export) row 3): its 2018-name «Nowhere» matches no row of Предмети - 2018; correct it to the name of a 2018 subject, or clear it.',
    ]);
    expect(
      linesOf({
        ...base,
        course_equivalencies: base.course_equivalencies.map((row) =>
          row['course_2023'] === courseNames.zeta
            ? { ...row, course_2018: 'Nowhere' }
            : row,
        ),
      }),
    ).toEqual([
      "- [unmatched_curriculum_2018_label] «Zeta Course» (Предмети (Export) row 7): its 2018 name «Nowhere», taken from Еквиваленции row 7, matches no row of Предмети - 2018; correct it in Еквиваленции, or fill in the course's 2018-name.",
    ]);
  });

  test('explain patterns that are no regular expression, and rows the model cannot hold', () => {
    const base = uniqueDataset();

    expect(linesOf(withMetacharacterCourse(base))).toEqual([
      '- [invalid_regex] «C++ Course» (Предмети (Export) row 10): the default enrollment pattern «C++ Course-<year>», which applies to every year without a pattern in Слушатели, is not a valid regular expression; add a valid pattern for each such year there, or rename the course.',
    ]);
    expect(
      linesOf(
        withPatterns(base, [
          {
            academic_year: '2020/2021',
            course_name: courseNames.beta,
            id: 9,
            pattern: String.raw`Beta\-2020`,
          },
          {
            academic_year: '2021/2022',
            course_name: courseNames.beta,
            id: 10,
            pattern: '',
          },
        ]),
      ),
    ).toEqual([
      '- [invalid_regex] «Beta Course» (Предмети (Export) row 3): the enrollment pattern on Слушатели row 5 is not a valid regular expression; correct it.',
      '- [invalid_source_row] Слушатели row 6 has no pattern; fill it in or delete the row.',
    ]);
    expect(linesOf(withCourse(base, courseNames.delta, { name: '' }))).toEqual([
      '- [invalid_source_row] Предмети (Export) row 5 has no name; fill it in or delete the row.',
    ]);
  });

  test('explain a course name several courses carry and repeated role rows', () => {
    const base = uniqueDataset();
    const [alpha] = base.courses;

    expect(
      linesOf({
        ...base,
        courses: [
          ...base.courses,
          { ...alpha, id: 90, name: courseNames.alpha },
        ],
        deans_office: [
          ...base.deans_office,
          { ...base.deans_office[0], id: 3 },
        ],
      }),
    ).toEqual([
      '- [ambiguous_course_name] Слушатели row 2 names «Alpha Course», which rows 2 and 10 of Предмети (Export) carry; give each course its own name.',
      '- [ambiguous_course_name] Еквиваленции row 2 names «Alpha Course», which rows 2 and 10 of Предмети (Export) carry; give each course its own name.',
      '- [ambiguous_course_name] Наставен Кадар row 2 names «Alpha Course», which rows 2 and 10 of Предмети (Export) carry; give each course its own name.',
      '- [duplicate_role_row] Деканат rows 2 and 4 repeat the same year, person and position; delete the repeated row.',
    ]);
  });

  test("never name staff, students or the dean's office", () => {
    const base = makeSyntheticDataset();
    const lines = linesOf({
      ...base,
      deans_office: [...base.deans_office, { ...base.deans_office[0], id: 3 }],
      student_council: [
        ...base.student_council,
        { ...base.student_council[2], id: 5 },
      ],
    }).join('\n');
    const personal = [
      ...base.staff.map((row) => row['name']),
      ...base.teaching_assignments.flatMap((row) => [
        row['professors'],
        row['assistants'],
      ]),
      ...base.students.flatMap((row) => [row['name'], row['index_number']]),
      ...base.deans_office.map((row) => row['name']),
      ...base.student_council.map((row) => row['index_number']),
    ].filter((value) => typeof value === 'string' && value !== '');

    expect(lines).toContain('[duplicate_assignment]');
    expect(lines).toContain('[ambiguous_student_index]');
    expect(lines).toContain('[duplicate_role_row]');

    for (const value of personal) {
      expect(lines).not.toContain(value);
    }
  });
});
