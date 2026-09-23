import { describe, expect, test } from 'vitest';

import { labelSeparator } from '../directus/extensions/directus-extension-data-operations/src/exports/course-values.js';
import {
  convertTeachingAssignments,
  roleKey,
} from '../src/migrations/assignments.js';
import { convertCouncilLinks } from '../src/migrations/council.js';
import { entryKey } from '../src/migrations/curricula.js';
import {
  convertEquivalencyLinks,
  type EquivalencyLinks,
} from '../src/migrations/equivalencies.js';
import { indexLabels } from '../src/migrations/labels.js';
import { staffListSeparator } from '../src/migrations/preflight-staff.js';
import { findField } from './data-model-test-helpers.js';
import {
  courseNames,
  makeSyntheticDataset,
} from './fixtures/synthetic-data.js';
import {
  codes,
  count,
  entryIdsOf,
  prepare,
  type Prepared,
  uniqueDataset,
  withAssignment,
  withStaff,
} from './relational-migration-helpers.js';

const alphaProfessors = 'Prof. Zed Alpha, Prof. Abe Alpha';
const alphaAssistants = 'Asst. Alpha One; Asst. Alpha Two';
const mixedProfessors = 'Prof. One, Prof. Two; Prof. Three';
const twin = 'Prof. Twin';
const thetaProfessor = 'Prof. Theta';

const noRoleRows: ReadonlyMap<string, readonly number[]> = new Map();

const convertAssignments = (
  prepared: Prepared,
  existing: ReadonlyMap<string, readonly number[]> = noRoleRows,
) =>
  convertTeachingAssignments({
    candidates: prepared.report.candidates.assignments,
    existing,
    rows: prepared.checkpoint.teaching_assignments,
    staffByName: indexLabels(prepared.checkpoint.staff, (row) => row.name),
  });

const roleRowsOf = (prepared: Prepared) =>
  convertAssignments(prepared).writes.map(({ record }) => record);

const emptyLinks = (): Map<number, EquivalencyLinks> => new Map();

describe('teaching assignments: review rows', () => {
  test('keeps unmatched text as one review row per role with the literal label and never splits on spaces', async () => {
    const prepared = await prepare(uniqueDataset());

    const conversion = convertAssignments(prepared);
    const rows = conversion.writes.map(({ record }) => record);
    const ofRow = (sourceId: number) =>
      rows.filter(({ source_id }) => source_id === sourceId);

    expect(rows).toHaveLength(10);
    expect(rows.every(({ staff }) => staff === null)).toBeTruthy();
    expect(ofRow(1)).toEqual([
      {
        assistants: null,
        course: 1,
        course_name: courseNames.alpha,
        display_override: alphaProfessors,
        professors: null,
        role: 'professor',
        sort: 1,
        source_collection: 'teaching_assignments',
        source_id: 1,
        staff: null,
      },
      {
        assistants: null,
        course: 1,
        course_name: courseNames.alpha,
        display_override: alphaAssistants,
        professors: null,
        role: 'assistant',
        sort: 1,
        source_collection: 'teaching_assignments',
        source_id: 1,
        staff: null,
      },
    ]);
    expect(ofRow(4).map(({ role }) => role)).toEqual(['professor']);
    expect(ofRow(5).map(({ role }) => role)).toEqual(['assistant']);
    expect(ofRow(6)).toEqual([]);
    expect(
      rows.some(
        ({ display_override }) => display_override === 'Prof. Zed Alpha',
      ),
    ).toBe(false);
    expect(count(conversion.findings, 'unresolved_staff_text')).toBe(10);
    expect(count(conversion.findings, 'orphan_assignment')).toBe(1);
    expect(conversion.findings).toHaveLength(11);
    expect(conversion.settled).toEqual([
      {
        relation: 'course',
        sourceCollection: 'teaching_assignments',
        sourceId: 6,
        status: 'unresolved',
        targetCollection: 'courses',
        targetId: null,
      },
    ]);
    expect(conversion.writes[0]?.mappings).toEqual([
      {
        relation: 'role:professor:1',
        sourceCollection: 'teaching_assignments',
        sourceId: 1,
        status: 'pending',
        targetCollection: 'teaching_assignments',
        targetId: null,
      },
    ]);
  });

  test('preserves duplicate assignment rows, never parses professors_override, and reuses existing role rows', async () => {
    const prepared = await prepare(makeSyntheticDataset());

    const rows = roleRowsOf(prepared);
    const alpha = rows.filter(({ course }) => course === 1);
    const beta = rows.filter(({ course }) => course === 2);

    expect(alpha.map(({ source_id, role }) => [source_id, role])).toEqual([
      [1, 'professor'],
      [1, 'assistant'],
      [2, 'professor'],
      [2, 'assistant'],
    ]);
    expect(
      rows.some(
        ({ display_override }) => display_override === 'Prof. Beta Override',
      ),
    ).toBe(false);
    expect(beta.map(({ display_override }) => display_override)).toEqual([
      'Prof. Beta Assigned',
      'Asst. Beta Assigned',
    ]);
    expect(rows.some(({ course }) => course === 3)).toBe(false);

    const reused = convertAssignments(
      prepared,
      new Map([[roleKey(1, 'professor'), [55, 56]]]),
    );

    expect(reused.writes).toHaveLength(rows.length - 1);
    expect(reused.settled).toContainEqual({
      relation: 'role:professor:1',
      sourceCollection: 'teaching_assignments',
      sourceId: 1,
      status: 'existing',
      targetCollection: 'teaching_assignments',
      targetId: 55,
    });
    expect(reused.settled).toContainEqual(
      expect.objectContaining({ relation: 'role:professor:2', targetId: 56 }),
    );
  });

  test('keeps a list that repeats a complete label as review text instead of inventing a duplicate relation', async () => {
    const repeated = `${thetaProfessor}, ${thetaProfessor}`;
    const prepared = await prepare(
      withAssignment(withStaff(uniqueDataset(), [thetaProfessor]), {
        id: 9,
        course_name: courseNames.delta,
        professors: repeated,
        assistants: null,
      }),
    );

    const conversion = convertAssignments(prepared);
    const rows = conversion.writes
      .map(({ record }) => record)
      .filter(({ source_id }) => source_id === 9);

    expect(
      prepared.report.candidates.assignments.find(({ id }) => id === 9)?.staff,
    ).toEqual([
      expect.objectContaining({ resolution: 'unresolved', text: repeated }),
      expect.objectContaining({ resolution: 'none' }),
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        display_override: repeated,
        role: 'professor',
        sort: 1,
        staff: null,
      }),
    ]);
    expect(conversion.findings.filter(({ ids }) => ids.includes(9))).toEqual([
      expect.objectContaining({ code: 'unresolved_staff_text' }),
    ]);
  });

  test('plans an unresolved text longer than a short string verbatim, which the model column can hold', async () => {
    const long = Array.from(
      { length: 40 },
      (_, index) => `Prof. Synthetic ${String(index)}`,
    ).join(' & ');
    const prepared = await prepare(
      withAssignment(uniqueDataset(), {
        id: 9,
        course_name: courseNames.delta,
        professors: long,
        assistants: null,
      }),
    );

    const rows = roleRowsOf(prepared).filter(
      ({ source_id }) => source_id === 9,
    );

    expect(long.length).toBeGreaterThan(255);
    expect(rows).toEqual([
      expect.objectContaining({ display_override: long, staff: null }),
    ]);
    expect(findField('teaching_assignments', 'display_override').kind).toBe(
      'text',
    );
  });
});

describe('teaching assignments: staff links', () => {
  test('links complete labels of a list joined exactly by ", " to one staff row each, in order', async () => {
    const prepared = await prepare(
      withStaff(uniqueDataset(), [
        'Prof. Abe Alpha',
        'Prof. Zed Alpha',
        'Asst. Alpha One',
        'Asst. Alpha Two',
        'Prof. Theta',
      ]),
    );

    const rows = roleRowsOf(prepared);
    const alpha = rows
      .filter(({ source_id }) => source_id === 1)
      .map(({ display_override, role, sort, staff }) => ({
        display_override,
        role,
        sort,
        staff,
      }));
    const theta = rows.find(
      ({ role, source_id }) => source_id === 7 && role === 'professor',
    );

    // The assistants use "; ": linked, the export would republish them
    // joined by ", ", so the text stays one literal review row.
    expect(alpha).toEqual([
      { display_override: null, role: 'professor', sort: 1, staff: 101 },
      { display_override: null, role: 'professor', sort: 2, staff: 100 },
      {
        display_override: alphaAssistants,
        role: 'assistant',
        sort: 1,
        staff: null,
      },
    ]);
    expect(theta).toMatchObject({ display_override: null, staff: 104 });
    expect(staffListSeparator).toBe(labelSeparator);
  });

  test.each([
    ['a "; " list', 'Prof. One; Prof. Two'],
    ['a ";" list', 'Prof. One;Prof. Two'],
    ['a line-break list', 'Prof. One\nProf. Two'],
    ['a "," list', 'Prof. One,Prof. Two'],
    ['a list with a padded part', 'Prof. One,  Prof. Two'],
    ['a list with a padded delimiter', 'Prof. One , Prof. Two'],
    ['a padded list', ' Prof. One, Prof. Two'],
    ['a padded label', 'Prof. One '],
  ])(
    'keeps %s literal although every part names one staff row',
    async (_label, text) => {
      const prepared = await prepare(
        withAssignment(withStaff(uniqueDataset(), ['Prof. One', 'Prof. Two']), {
          id: 9,
          course_name: courseNames.delta,
          professors: text,
          assistants: null,
        }),
      );

      const conversion = convertAssignments(prepared);
      const rows = conversion.writes
        .map(({ record }) => record)
        .filter(({ source_id }) => source_id === 9);

      expect(rows).toEqual([
        expect.objectContaining({
          display_override: text,
          role: 'professor',
          sort: 1,
          staff: null,
        }),
      ]);
      expect(conversion.findings.filter(({ ids }) => ids.includes(9))).toEqual([
        expect.objectContaining({ code: 'unresolved_staff_text' }),
      ]);
    },
  );

  test('retains text with mixed delimiters or a label several staff rows carry, naming the contention', async () => {
    const mixed = await prepare(
      withAssignment(
        withStaff(uniqueDataset(), ['Prof. One', 'Prof. Two', 'Prof. Three']),
        {
          id: 9,
          course_name: courseNames.delta,
          professors: mixedProfessors,
          assistants: null,
        },
      ),
    );
    const ambiguous = await prepare(
      withAssignment(withStaff(uniqueDataset(), [twin, twin]), {
        id: 9,
        course_name: courseNames.delta,
        professors: twin,
        assistants: null,
      }),
    );

    const mixedRows = roleRowsOf(mixed).filter(
      ({ source_id }) => source_id === 9,
    );
    const ambiguousConversion = convertAssignments(ambiguous);
    const ambiguousRows = ambiguousConversion.writes
      .map(({ record }) => record)
      .filter(({ source_id }) => source_id === 9);

    expect(
      mixedRows.map(({ display_override, staff }) => [display_override, staff]),
    ).toEqual([[mixedProfessors, null]]);
    expect(
      ambiguousRows.map(({ display_override, staff }) => [
        display_override,
        staff,
      ]),
    ).toEqual([[twin, null]]);
    expect(
      ambiguousConversion.findings.filter(
        ({ code }) => code === 'ambiguous_staff_label',
      ),
    ).toEqual([
      expect.objectContaining({ collection: 'teaching_assignments', ids: [9] }),
    ]);
  });
});

describe('student council links', () => {
  test('links a member only when exactly one student carries the index and retains the rest for review', async () => {
    const unique = await prepare(uniqueDataset());
    const duplicate = await prepare(makeSyntheticDataset());
    const empty = new Map<number, null | number>();

    const linked = convertCouncilLinks({
      candidates: unique.report.candidates.council,
      current: empty,
    });
    const blocked = convertCouncilLinks({
      candidates: duplicate.report.candidates.council,
      current: empty,
    });

    expect(linked.writes.map(({ record }) => record)).toEqual([
      { id: 1, student: 1 },
      { id: 3, student: 3 },
      { id: 4, student: 4 },
    ]);
    expect(linked.writes[0]?.mappings).toEqual([
      {
        relation: 'student',
        sourceCollection: 'student_council',
        sourceId: 1,
        status: 'pending',
        targetCollection: 'students',
        targetId: 1,
      },
    ]);
    expect(codes(linked.findings)).toEqual(['unmatched_council_index']);
    expect(linked.settled).toEqual([
      expect.objectContaining({
        sourceId: 2,
        status: 'unresolved',
        targetId: null,
      }),
    ]);
    expect(blocked.writes.map(({ record }) => record.id)).toEqual([3, 4]);
    expect(codes(blocked.findings)).toEqual([
      'ambiguous_student_index',
      'unmatched_council_index',
    ]);
    expect(duplicate.checkpoint.students).toHaveLength(4);
  });

  test('skips a link already set and never overwrites a link set by hand', async () => {
    const { report } = await prepare(uniqueDataset());

    const conversion = convertCouncilLinks({
      candidates: report.candidates.council,
      current: new Map([
        [1, 1],
        [3, 4],
        [4, null],
      ]),
    });

    expect(conversion.writes.map(({ record }) => record)).toEqual([
      { id: 4, student: 4 },
    ]);
    expect(conversion.settled).toContainEqual(
      expect.objectContaining({ sourceId: 1, status: 'existing', targetId: 1 }),
    );
    expect(conversion.settled).toContainEqual(
      expect.objectContaining({ sourceId: 3, status: 'existing', targetId: 4 }),
    );
    expect(
      conversion.findings.filter(({ code }) => code === 'manual_link_retained'),
    ).toEqual([
      expect.objectContaining({ collection: 'student_council', ids: [3] }),
    ]);
  });
});

describe('equivalency links', () => {
  test('sets the course and the entries of represented generations when unique and retains every label', async () => {
    const prepared = await prepare(uniqueDataset());
    const entryIds = entryIdsOf(prepared.checkpoint);

    const conversion = convertEquivalencyLinks({
      candidates: prepared.report.candidates.equivalencies,
      current: emptyLinks(),
      entryIds,
    });
    const patches = conversion.writes.map(({ record }) => record);
    const patchOf = (id: number) => patches.find((patch) => patch.id === id);

    expect(patches.map(({ id }) => id)).toEqual([1, 3, 4, 5, 6, 7, 8, 9]);
    expect(patchOf(1)).toEqual({
      id: 1,
      course: 1,
      entry_2023: entryIds.get(entryKey('curriculum_2023', 3)),
      entry_2018: entryIds.get(entryKey('curriculum_2018', 1)),
    });
    expect(patchOf(5)).toEqual({
      id: 5,
      course: 3,
      entry_2023: entryIds.get(entryKey('curriculum_2023', 5)),
    });
    expect(patchOf(9)).toEqual({
      id: 9,
      entry_2018: entryIds.get(entryKey('curriculum_2018', 8)),
    });
    expect(patchOf(10)).toBeUndefined();
    expect(codes(conversion.findings)).toEqual([
      'orphan_equivalency',
      'orphan_equivalency',
      'orphan_equivalency',
      'unmatched_equivalency_entry',
      'unmatched_equivalency_entry',
    ]);
    expect(
      conversion.settled.filter(({ sourceId }) => sourceId === 10),
    ).toEqual([
      expect.objectContaining({ relation: 'course', status: 'unresolved' }),
    ]);
    expect(conversion.writes[0]?.mappings).toEqual([
      expect.objectContaining({
        relation: 'course',
        sourceId: 1,
        status: 'pending',
        targetCollection: 'courses',
        targetId: 1,
      }),
      expect.objectContaining({
        relation: 'entry_2023',
        sourceId: 1,
        status: 'pending',
        targetCollection: 'curriculum_entries',
      }),
      expect.objectContaining({
        relation: 'entry_2018',
        sourceId: 1,
        status: 'pending',
        targetCollection: 'curriculum_entries',
      }),
    ]);
    expect(JSON.stringify(patches)).not.toContain('Ancient');
  });

  test('leaves an ambiguous entry label unlinked, skips links already set and keeps manual links', async () => {
    const prepared = await prepare(makeSyntheticDataset());
    const entryIds = entryIdsOf(prepared.checkpoint);

    const conversion = convertEquivalencyLinks({
      candidates: prepared.report.candidates.equivalencies,
      current: new Map([
        [4, { course: 2, entry_2018: null, entry_2023: 9_999 }],
      ]),
      entryIds,
    });
    const patches = conversion.writes.map(({ record }) => record);
    const patchOf = (id: number) => patches.find((patch) => patch.id === id);
    const ambiguous = conversion.findings.filter(
      ({ code }) => code === 'ambiguous_equivalency_entry',
    );

    expect(patchOf(1)).toEqual({
      id: 1,
      course: 1,
      entry_2023: entryIds.get(entryKey('curriculum_2023', 3)),
    });
    expect(ambiguous.map(({ ids, label }) => [ids, label])).toEqual([
      [[1], 'Alpha Legacy'],
      [[3], 'Alpha Course (2023)'],
    ]);
    expect(patchOf(4)).toEqual({
      id: 4,
      entry_2018: entryIds.get(entryKey('curriculum_2018', 4)),
    });
    expect(conversion.settled).toContainEqual(
      expect.objectContaining({
        relation: 'course',
        sourceId: 4,
        status: 'existing',
        targetId: 2,
      }),
    );
    expect(conversion.settled).toContainEqual(
      expect.objectContaining({
        relation: 'entry_2023',
        sourceId: 4,
        status: 'existing',
        targetId: 9_999,
      }),
    );
    expect(
      conversion.findings.filter(({ code }) => code === 'manual_link_retained'),
    ).toEqual([
      expect.objectContaining({ collection: 'course_equivalencies', ids: [4] }),
    ]);
  });
});
