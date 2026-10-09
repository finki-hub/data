import { describe, expect, test } from 'vitest';

import type { ImportPlan } from '../src/import/plan.js';

import { snapshotFields } from '../directus/extensions/directus-extension-data-operations/src/snapshot/contract.js';
import { entryKey } from '../src/import/curricula.js';
import {
  ProgramHeaderError,
  programKey,
  workbookPrograms,
} from '../src/import/generations.js';
import { compositeKey, isRef, type Ref, ref } from '../src/import/planned.js';
import { projectedCounts } from '../src/projection/counts.js';
import { memoryStore } from '../src/projection/memory-store.js';
import { expectedEnrollments } from './expected-exports.js';
import {
  academicYears,
  courseNames,
  makeSyntheticDataset,
  thetaCrossNewlinePattern,
} from './fixtures/synthetic-data.js';
import {
  syntheticProgramHeaders,
  syntheticPrograms,
} from './fixtures/synthetic-workbook.js';
import {
  planOf,
  recordsIn,
  rowsIn,
  uniqueDataset,
  withCourse,
} from './import-plan-helpers.js';

const orphanLegacy = 'Orphan Legacy Course';

const generation = (code: string) => ref('curriculum_generations', code);
const course = (id: number) => ref('courses', id);
const entry2023 = (id: number) =>
  ref('curriculum_entries', entryKey('curriculum_2023', id));
const entry2018 = (id: number) =>
  ref('curriculum_entries', entryKey('curriculum_2018', id));

// The references of the plan to a collection it writes later, or not at
// all.
const lateReferences = (plan: ImportPlan): readonly Ref[] => {
  const written = new Set<string>();
  const late: Ref[] = [];
  for (const { collection, rows } of plan.collections) {
    for (const { record } of rows) {
      late.push(
        ...Object.values(record).filter(
          (value): value is Ref =>
            isRef(value) && !written.has(value.collection),
        ),
      );
    }
    written.add(collection);
  }
  return late;
};

// Whether a record still carries a flat state column.
const hasStateColumn = (record: object): boolean =>
  Object.keys(record).some((key) => key.startsWith('state_'));

describe('the order the import writes in', () => {
  test('writes every collection after the rows its references name', () => {
    const plan = planOf(uniqueDataset());
    const order = plan.collections.map(({ collection }) => collection);

    expect(order).toEqual([
      'academic_years',
      'curriculum_generations',
      'study_programs',
      'staff',
      'rooms',
      'students',
      'discord_channels',
      'deans_office',
      'moodle_users',
      'courses',
      'curriculum_entries',
      'curriculum_entry_program_states',
      'course_curricula',
      'course_enrollment_rules',
      'moodle_pattern_mappings',
      'teaching_assignments',
      'course_equivalencies',
      'course_equivalency_members',
      'student_council',
    ]);

    expect(lateReferences(plan)).toEqual([]);
  });
});

describe('seeds', () => {
  test('seeds the three workbook generations, the programs its headers name and its academic years', () => {
    const plan = planOf(uniqueDataset());

    expect(recordsIn(plan, 'curriculum_generations')).toEqual([
      {
        code: '2013',
        has_curriculum: false,
        label: 'Curriculum 2013',
        published: false,
        sort: 1,
      },
      {
        code: '2018',
        has_curriculum: true,
        label: 'Curriculum 2018',
        published: true,
        sort: 2,
      },
      {
        code: '2023',
        has_curriculum: true,
        label: 'Curriculum 2023',
        published: true,
        sort: 3,
      },
    ]);
    expect(recordsIn(plan, 'study_programs')).toHaveLength(15);
    expect(recordsIn(plan, 'study_programs')[8]).toEqual({
      code: 'kn',
      generation: generation('2018'),
      name: 'КН',
      published: true,
      sort: 1,
    });
    expect(recordsIn(plan, 'academic_years').map(({ label }) => label)).toEqual(
      [...academicYears],
    );
    expect(recordsIn(plan, 'academic_years')[0]).toEqual({
      label: '2025/2026',
      published: true,
      sort: 15,
    });
  });

  test('maps each program header to its code, in column order, and refuses an unknown or misplaced header', () => {
    expect(
      syntheticPrograms.map(({ code, generation: of, name, sort }) =>
        [of, sort, code, name].join(' '),
      ),
    ).toEqual([
      '2023 1 kn КН',
      '2023 2 siis СИИС',
      '2023 3 pit ПИТ',
      '2023 4 imb ИМБ',
      '2023 5 ki КИ',
      '2023 6 ie ИЕ',
      '2023 7 ssp ССП',
      '2023 8 seis SEIS',
      '2018 1 kn КН',
      '2018 2 siis СИИС',
      '2018 3 pit ПИТ',
      '2018 4 imb ИМБ',
      '2018 5 ki КИ',
      '2018 6 ke КЕ',
      '2018 7 seis SEIS',
    ]);
    expect(() =>
      workbookPrograms({
        ...syntheticProgramHeaders,
        curriculum_2018: ['КН', 'СИИС', 'ПИТ', 'ИМБ', 'КИ', 'XYZ', 'SEIS'],
      }),
    ).toThrow(ProgramHeaderError);
    expect(() =>
      workbookPrograms({
        ...syntheticProgramHeaders,
        curriculum_2023: [
          'СИИС',
          'КН',
          'ПИТ',
          'ИМБ',
          'КИ',
          'ИЕ',
          'ССП',
          'SEIS',
        ],
      }),
    ).toThrow('Предмети - 2023 row 1, column 8: header "СИИС", expected "КН"');
  });
});

describe('content rows', () => {
  test('copies every workbook column the model declares and nothing else', () => {
    const dataset = makeSyntheticDataset();
    const plan = planOf(dataset);

    expect(recordsIn(plan, 'courses')[1]).toEqual({
      name: courseNames.beta,
      status: 'active',
      tags: '',
    });
    expect(recordsIn(plan, 'staff')).toHaveLength(dataset.staff.length);
    expect(recordsIn(plan, 'moodle_users')[0]).toHaveProperty('ID_old', 1_001);
    expect(recordsIn(plan, 'moodle_users')[0]).toHaveProperty('ID_new', 2_001);
    expect(
      new Set(Object.keys(recordsIn(plan, 'moodle_users')[0] ?? {})),
    ).toEqual(new Set(snapshotFields));
    expect(recordsIn(plan, 'student_council')[2]).toMatchObject({
      index_number: 'SYN-0002',
      student: ref('students', 3),
    });
    expect(Object.keys(recordsIn(plan, 'student_council')[2] ?? {})).toEqual([
      'year',
      'index_number',
      'position',
      'student',
    ]);
    expect(recordsIn(plan, 'student_council')[0]).toMatchObject({
      student: null,
    });
    expect(rowsIn(plan, 'courses')[0]?.origin).toEqual({
      id: 1,
      source: 'courses',
    });
  });

  test('imports every student row, two that share an index included', () => {
    const students = rowsIn(planOf(makeSyntheticDataset()), 'students');

    expect(
      students.map(({ origin, record }) => [
        origin?.id,
        record['index_number'],
      ]),
    ).toEqual([
      [1, 'SYN-0001'],
      [2, 'SYN-0001'],
      [3, 'SYN-0002'],
      [4, 'SYN-0003'],
    ]);
  });
});

describe('curriculum entries and program states', () => {
  test('writes every 2023 and 2018 row as an entry of its generation, orphans and duplicates included, literally', () => {
    const dataset = makeSyntheticDataset();
    const entries = rowsIn(planOf(dataset), 'curriculum_entries');
    const records = entries.map(({ record }) => record);

    expect(entries.map(({ key }) => key)).toEqual([
      ...dataset.curriculum_2023.map((_, index) =>
        entryKey('curriculum_2023', index + 1),
      ),
      ...dataset.curriculum_2018.map((_, index) =>
        entryKey('curriculum_2018', index + 1),
      ),
    ]);
    expect(records.find(({ name }) => name === orphanLegacy)).toMatchObject({
      channel: true,
      code: 'F18L1W999',
      generation: generation('2018'),
    });
    expect(
      records.find(
        (record) =>
          record['name'] === courseNames.zeta &&
          JSON.stringify(record['generation']) ===
            JSON.stringify(generation('2023')),
      ),
    ).toMatchObject({
      channel: null,
      code: '',
      prerequisites: '',
      semester: 6,
      url: 'https://curriculum.example/2023/7',
    });
    expect(records.filter(hasStateColumn)).toEqual([]);
  });

  test('writes one state row per nonempty program cell, for the program of the entry’s generation', () => {
    const plan = planOf(uniqueDataset());
    const states = recordsIn(plan, 'curriculum_entry_program_states');
    const epsilon = entry2023(5);

    expect(
      states
        .filter(
          (state) => JSON.stringify(state['entry']) === JSON.stringify(epsilon),
        )
        .map(({ program, state }) => [program, state]),
    ).toEqual(
      ['kn', 'siis', 'pit', 'imb', 'ki', 'ie', 'ssp', 'seis'].map((code) => [
        ref('study_programs', programKey('2023', code)),
        `${code}-state`,
      ]),
    );
    // Zeta's empty cells write no row.
    expect(
      states.some(
        (state) =>
          JSON.stringify(state['entry']) === JSON.stringify(entry2023(6)),
      ),
    ).toBe(false);
  });
});

describe('course links', () => {
  test('links each course to its unique 2023 and 2018 entries with the credits and availability of that generation', () => {
    const plan = planOf(uniqueDataset());
    const links = rowsIn(plan, 'course_curricula');
    const linkOf = (id: number, code: string) =>
      links.find(({ key }) => key === compositeKey(id, code))?.record;

    expect(links).toHaveLength(12);
    expect(linkOf(1, '2023')).toEqual({
      available: true,
      course: course(1),
      credits: 6,
      entry: entry2023(1),
      generation: generation('2023'),
      sort: 1,
    });
    expect(linkOf(1, '2018')).toEqual({
      available: false,
      course: course(1),
      credits: 6,
      entry: entry2018(1),
      generation: generation('2018'),
      sort: 2,
    });
    expect(linkOf(2, '2018')).toMatchObject({
      available: true,
      credits: 0,
      entry: entry2018(3),
    });
    expect(linkOf(4, '2023')).toBeUndefined();
    expect(linkOf(3, '2018')).toBeUndefined();
    expect(linkOf(8, '2018')).toBeUndefined();
  });

  test('links a course whose availability cell is empty as not available', () => {
    const plan = planOf(
      withCourse(uniqueDataset(), courseNames.alpha, {
        available_2018: null,
        available_2023: null,
      }),
    );
    const links = rowsIn(plan, 'course_curricula').filter(({ key }) =>
      [compositeKey(1, '2018'), compositeKey(1, '2023')].includes(key),
    );

    expect(links.map(({ record }) => record['available'])).toEqual([
      false,
      false,
    ]);
    expect(plan.unstorable).toEqual([]);
  });

  test('links no label that names several entries or none', () => {
    const plan = planOf(makeSyntheticDataset());

    expect(
      rowsIn(plan, 'course_curricula').some(({ key }) =>
        key.startsWith(compositeKey(1, '')),
      ),
    ).toBe(false);
  });
});

describe('enrollment rules', () => {
  test('seeds one legacy_regex rule per course and year, the last pattern of the workbook or the default recorded literally', () => {
    const plan = planOf(makeSyntheticDataset());
    const rules = rowsIn(plan, 'course_enrollment_rules');
    const ruleOf = (id: number, year: string) =>
      rules.find(({ key }) => key === compositeKey(id, year))?.record;

    expect(rules).toHaveLength(8 * academicYears.length);
    expect(ruleOf(1, '2025/2026')).toMatchObject({
      academic_year: ref('academic_years', '2025/2026'),
      course: course(1),
      mode: 'legacy_regex',
      pattern: 'Alpha Honors-2025/2026',
    });
    expect(ruleOf(1, '2025/2026')?.['review_note']).toBe(
      'Import: workbook pattern, last of 2 for this course and year',
    );
    expect(ruleOf(7, '2021/2022')?.['pattern']).toBe(thetaCrossNewlinePattern);
    expect(ruleOf(1, '2024/2025')).toMatchObject({
      pattern: 'Alpha Course-2024/2025',
    });
    expect(ruleOf(1, '2024/2025')?.['review_note']).toBe(
      'Import fallback: default pattern (course name-academic year), stored literally; no workbook pattern',
    );
    expect(ruleOf(8, '2025/2026')?.['pattern']).toBe(
      'Iota 2.0 Course-2025/2026',
    );
  });

  // The counts the enrollments run installs: the planned pattern mappings
  // matched line by line (src/projection/counts.ts), keyed by the course's
  // workbook id and the academic year.
  test('the planned pattern mappings count exactly the committed enrollments', async () => {
    const plan = planOf(makeSyntheticDataset());
    const store = memoryStore(plan.collections);
    const keysOf = (collection: 'academic_years' | 'courses') =>
      rowsIn(plan, collection).map(({ key }) => key);
    const courses = keysOf('courses');
    const years = keysOf('academic_years');

    expect(
      Object.fromEntries(
        projectedCounts(store).rows.map((row) => [
          `${String(courses[Number(row['course']) - 1])}/${String(years[Number(row['academic_year']) - 1])}`,
          row['count'],
        ]),
      ),
    ).toEqual(await expectedEnrollments('synthetic'));
  });
});

describe('equivalencies and their members', () => {
  test('links the course when its 2023 label names one and plans one member per filled label with the entry decisions of the check', () => {
    const dataset = uniqueDataset();
    const plan = planOf(dataset);
    const members = rowsIn(plan, 'course_equivalency_members');
    const memberOf = (id: number, code: string) =>
      members.find(({ key }) => key === compositeKey(id, code))?.record;

    expect(recordsIn(plan, 'course_equivalencies')).toEqual([
      { course: course(1) },
      { course: null },
      { course: course(2) },
      { course: course(3) },
      { course: course(5) },
      { course: course(6) },
      { course: course(7) },
      { course: null },
      { course: null },
    ]);
    expect(memberOf(1, '2023')).toEqual({
      entry: entry2023(2),
      equivalency: ref('course_equivalencies', 1),
      generation: generation('2023'),
      label: courseNames.alpha,
      sort: 1,
    });
    expect(memberOf(1, '2018')).toMatchObject({
      entry: entry2018(1),
      label: 'Alpha Legacy',
      sort: 2,
    });
    expect(memberOf(1, '2013')).toMatchObject({
      entry: null,
      label: 'Alpha Ancient',
      sort: 3,
    });
    expect(memberOf(9, '2023')).toBeUndefined();
    expect(memberOf(9, '2013')).toMatchObject({ entry: null, sort: 3 });
  });

  test('keeps a label that names several entries or none as a member without an entry, its label literal', () => {
    const members = rowsIn(
      planOf(makeSyntheticDataset()),
      'course_equivalency_members',
    );
    const memberOf = (id: number, code: string) =>
      members.find(({ key }) => key === compositeKey(id, code))?.record;

    // Two 2018 rows carry "Alpha Legacy" and two 2023 rows "Alpha Course
    // (2023)"; no 2018 row carries "Alpha Legacy Decoy".
    expect(memberOf(1, '2018')).toEqual({
      entry: null,
      equivalency: ref('course_equivalencies', 1),
      generation: generation('2018'),
      label: 'Alpha Legacy',
      sort: 2,
    });
    expect(memberOf(3, '2023')).toMatchObject({
      entry: null,
      label: 'Alpha Course (2023)',
      sort: 1,
    });
    expect(memberOf(3, '2018')).toMatchObject({
      entry: null,
      label: 'Alpha Legacy Decoy',
      sort: 2,
    });
    expect(memberOf(1, '2023')?.['entry']).toEqual(entry2023(3));
  });
});

describe('teaching role rows', () => {
  test('plans the links of every course a teaching row or a typed export row names, and skips an orphan row', () => {
    const dataset = uniqueDataset();
    const rows = rowsIn(planOf(dataset), 'teaching_assignments');
    const courses = rows.map(({ record }) => record['course']);

    // Alpha 3, Beta 1, Gamma 1, Zeta 1, Theta 2, Iota 3; Delta and
    // Epsilon replace every name by their status text.
    expect(rows).toHaveLength(11);
    expect(courses).toEqual(
      [1, 1, 1, 2, 3, 6, 7, 7, 8, 8, 8].map((id) => course(id)),
    );
    expect(rows.map(({ origin }) => origin?.source)).not.toContain(undefined);
    expect(new Set(rows.flatMap(({ record }) => Object.keys(record)))).toEqual(
      new Set(['course', 'role', 'sort', 'staff']),
    );
  });
});
