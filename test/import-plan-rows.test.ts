import { describe, expect, test } from 'vitest';

import {
  courseNames,
  staffNames,
  type SyntheticDataset,
} from './fixtures/synthetic-data.js';
import {
  planOf,
  recordsIn,
  rowsIn,
  uniqueDataset,
  withCourse,
} from './import-plan-helpers.js';

const course = (id: number) => ({ collection: 'courses', key: String(id) });
const staff = (id: number) => ({ collection: 'staff', key: String(id) });

// The role rows the plan writes for the course of the ordinal.
const roleRowsOf = (dataset: SyntheticDataset, ordinal: number) =>
  rowsIn(planOf(dataset), 'teaching_assignments').filter(
    ({ record }) =>
      JSON.stringify(record['course']) === JSON.stringify(course(ordinal)),
  );

describe('teaching assignments: staff links', () => {
  test('plans one role row per named staff row, professors first, numbered in cell order', () => {
    const dataset = uniqueDataset();

    // Iota: professors Active, Inactive, Active (a repeat, linked once),
    // assistants Minimal.
    expect(
      roleRowsOf(dataset, 8).map(({ key, record }) => [key, record]),
    ).toEqual([
      [
        '8\u{0}1',
        { course: course(8), role: 'professor', sort: 1, staff: staff(1) },
      ],
      [
        '8\u{0}2',
        { course: course(8), role: 'professor', sort: 2, staff: staff(2) },
      ],
      [
        '8\u{0}3',
        { course: course(8), role: 'assistant', sort: 3, staff: staff(3) },
      ],
    ]);
    // The cell order, not the staff order: Minimal before Active.
    expect(
      roleRowsOf(dataset, 1).map(({ record }) => [
        record['role'],
        record['staff'],
      ]),
    ).toEqual([
      ['professor', staff(3)],
      ['professor', staff(1)],
      ['assistant', staff(2)],
    ]);
  });

  test('places each role row at the row its cells come from', () => {
    const dataset = uniqueDataset();

    expect(roleRowsOf(dataset, 1).map(({ origin }) => origin)).toEqual([
      { id: 1, source: 'teaching_assignments' },
      { id: 1, source: 'teaching_assignments' },
      { id: 1, source: 'teaching_assignments' },
    ]);
    expect(roleRowsOf(dataset, 2).map(({ origin }) => origin)).toEqual([
      { id: 2, source: 'courses' },
    ]);
  });

  test('links nobody for Inactive, and only assistants for All professors', () => {
    const dataset = uniqueDataset();

    expect(roleRowsOf(dataset, 4)).toEqual([]);
    expect(roleRowsOf(dataset, 5)).toEqual([]);
    expect(roleRowsOf(dataset, 6).map(({ record }) => record)).toEqual([
      { course: course(6), role: 'assistant', sort: 1, staff: staff(3) },
    ]);
  });

  test('writes the status and Discord channel of every course and never the professors override', () => {
    const records = recordsIn(planOf(uniqueDataset()), 'courses');

    expect(records.map((record) => record['status'])).toEqual([
      'active',
      'active',
      'active',
      'inactive',
      'all_professors',
      'all_professors',
      'active',
      'active',
    ]);
    expect(new Set(records.flatMap((record) => Object.keys(record)))).toEqual(
      new Set(['name', 'status', 'tags']),
    );
  });

  test('reads the shown assistants of an export row only when its professors are typed', () => {
    const shown = (name: string) =>
      withCourse(uniqueDataset(), name, {
        export_assistants: staffNames.inactive,
      });

    expect(
      roleRowsOf(shown(courseNames.beta), 2).map(({ record }) => [
        record['role'],
        record['staff'],
      ]),
    ).toEqual([
      ['professor', staff(1)],
      ['assistant', staff(2)],
    ]);
    // Alpha's professors are not typed: its teaching row decides.
    expect(roleRowsOf(shown(courseNames.alpha), 1)).toEqual(
      roleRowsOf(uniqueDataset(), 1),
    );
  });
});
