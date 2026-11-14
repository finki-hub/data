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
