import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { FakeStore } from './store-test-helpers.js';

import { exportDefinitions } from '../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { courseNames, staffNames } from './fixtures/synthetic-data.js';
import { storeReader } from './memory-reader.js';
import {
  edit,
  engineAssets,
  importedStore,
  refusalOf,
  rowsOf,
  withValues,
} from './relational-export-helpers.js';

// Theta Course, row 7 of the imported parity store: professor Synthetic
// Staff Minimal, assistant Synthetic Staff Active.
const theta = 7;

const rowsSchema = z.array(z.record(z.string(), z.string()));

// The courses.json rows the definitions publish over a store.
const coursesOf = async (store: FakeStore) => {
  const assets = await engineAssets(exportDefinitions, storeReader(store));
  return rowsSchema.parse(assets['courses']);
};

const thetaRow = async (store: FakeStore) => {
  const courses = await coursesOf(store);
  return courses.find((row) => row['name'] === courseNames.theta);
};

// The store with the course's status set.
const withStatus = (store: FakeStore, course: number, status: string) =>
  withValues(store, { collection: 'courses', id: course }, { status });

// The store without the course's links of the role.
const withoutLinks = (store: FakeStore, course: number, role: string) =>
  edit(store, 'teaching_assignments', (rows) =>
    rows.filter((row) => row['course'] !== course || row['role'] !== role),
  );

// The store with a link of Theta in the role that names no staff member.
const withStaffless = (store: FakeStore, role: string) =>
  edit(store, 'teaching_assignments', (rows) => [
    ...rows,
    { course: theta, id: 500, role, sort: 1, staff: null },
  ]);

const withStafflessProfessor = (store: FakeStore) =>
  withStaffless(store, 'professor');

const unchanged = (store: FakeStore) => store;

// The fixture's staff: 1 Active, 2 Inactive, 3 Minimal.
const staffIds = { active: 1, inactive: 2, minimal: 3 } as const;

type TeachingRow = {
  readonly periods: number;
  readonly role: string;
  readonly staff: number;
  readonly timetable: number;
};

// The store with three timetables, the first two published, and Theta's
// teaching rows in them.
const withTeaching = (store: FakeStore, rows: readonly TeachingRow[]) =>
  edit(
    edit(store, 'timetables', () => [
      { date_from: '2026-10-10', id: 1, recent: true },
      { date_from: '2026-02-23', id: 2, recent: true },
      { date_from: '2020-10-16', id: 3, recent: false },
    ]),
    'course_teaching',
    () => rows.map((row, index) => ({ course: theta, id: index + 1, ...row })),
  );

// The store with Theta's accreditation teachers: one of generation 2018
// and two of 2023.
const withAccreditation = (store: FakeStore) =>
  edit(store, 'course_accreditation_staff', () => [
    { course: theta, generation: 2, id: 1, sort: 1, staff: staffIds.active },
    { course: theta, generation: 3, id: 2, sort: 2, staff: staffIds.minimal },
    { course: theta, generation: 3, id: 3, sort: 1, staff: staffIds.inactive },
  ]);

describe('teaching staff by status', () => {
  test('publishes the Inactive text as both keys and the All professors text as professors, whatever the links are', async () => {
    // A link the status replaces is not read, even without staff.
    const inactive = withStaffless(
      withStatus(await importedStore(), theta, 'inactive'),
      'assistant',
    );
    const allProfessors = withStafflessProfessor(
      withStatus(await importedStore(), theta, 'all_professors'),
    );

    await expect(thetaRow(inactive)).resolves.toMatchObject({
      assistants: '(неактивиран предмет)',
      professors: '(неактивиран предмет)',
    });
    await expect(thetaRow(allProfessors)).resolves.toMatchObject({
      assistants: staffNames.active,
      professors: 'Сите професори',
    });
    // The links stay, unpublished.
    expect(
      rowsOf(inactive, 'teaching_assignments').filter(
        (row) => row['course'] === theta,
      ),
    ).toHaveLength(3);
  });

  test('leaves the assistants key out without an assistant link', async () => {
    const store = withoutLinks(await importedStore(), theta, 'assistant');
    const courses = await coursesOf(store);
    const named = (name: string) => courses.find((row) => row['name'] === name);

    expect(named(courseNames.theta)).not.toHaveProperty('assistants');
    expect(named(courseNames.theta)?.['professors']).toBe(staffNames.minimal);
    expect(named(courseNames.beta)).not.toHaveProperty('assistants');
  });

  test.each([
    ['no professor link', unchanged],
    ['a professor link without staff', withStafflessProfessor],
  ])(
    'refuses the file for an Active course with %s',
    async (_label, change) => {
      const store = change(
        withoutLinks(await importedStore(), theta, 'professor'),
      );

      await expect(refusalOf(() => coursesOf(store))).resolves.toMatchObject({
        code: 'EXPORT_UNRESOLVED',
      });
    },
  );

  test('refuses an Active course without a professor name and a status outside the vocabulary', async () => {
    const missing = withoutLinks(await importedStore(), theta, 'professor');
    const unknown = withStatus(await importedStore(), theta, 'retired');

    await expect(refusalOf(() => coursesOf(missing))).resolves.toEqual({
      code: 'EXPORT_UNRESOLVED',
      message: 'Course 7: professor missing',
    });
    await expect(refusalOf(() => coursesOf(unknown))).resolves.toEqual({
      code: 'EXPORT_UNRESOLVED',
      message: 'Course 7: invalid status',
    });
  });

  test('needs no professor link for an Inactive or All professors course', async () => {
    const inactive = withStatus(
      withoutLinks(await importedStore(), theta, 'professor'),
      theta,
      'inactive',
    );

    // Delta (Inactive), Epsilon and Zeta (All professors) have none.
    await expect(coursesOf(await importedStore())).resolves.toHaveLength(8);
    await expect(coursesOf(inactive)).resolves.toHaveLength(8);
  });
});

describe('teaching staff by source', () => {
  test('publishes who taught the course in the published timetables over its accreditation and links', async () => {
    const store = withAccreditation(
      withTeaching(await importedStore(), [
        {
          periods: 4,
          role: 'professor',
          staff: staffIds.inactive,
          timetable: 1,
        },
        { periods: 2, role: 'assistant', staff: staffIds.active, timetable: 1 },
        { periods: 3, role: 'professor', staff: staffIds.active, timetable: 2 },
        {
          periods: 2,
          role: 'assistant',
          staff: staffIds.minimal,
          timetable: 1,
        },
        // An unpublished timetable is not read.
        {
          periods: 2,
          role: 'professor',
          staff: staffIds.minimal,
          timetable: 3,
        },
      ]),
    );

    // A professor in any published timetable is a professor; each list
    // runs from the latest timetable, then the most weekly periods in it.
    await expect(thetaRow(store)).resolves.toMatchObject({
      assistants: staffNames.minimal,
      professors: [staffNames.inactive, staffNames.active].join('\n'),
    });
  });

  test("falls back to the newest generation's accreditation teachers, with no assistants", async () => {
    const store = withAccreditation(
      withTeaching(await importedStore(), [
        { periods: 2, role: 'professor', staff: staffIds.active, timetable: 3 },
      ]),
    );
    const row = await thetaRow(store);

    expect(row?.['professors']).toBe(
      [staffNames.inactive, staffNames.minimal].join('\n'),
    );
    expect(row).not.toHaveProperty('assistants');
  });

  test('falls back to the hand-kept links without either', async () => {
    await expect(thetaRow(await importedStore())).resolves.toMatchObject({
      assistants: staffNames.active,
      professors: staffNames.minimal,
    });
  });
});
