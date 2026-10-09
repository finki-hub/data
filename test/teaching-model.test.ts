import { describe, expect, test } from 'vitest';

import { teachingTexts } from '../directus/extensions/directus-extension-data-operations/src/exports/teaching-values.js';
import { schemaConstraints } from '../directus/extensions/directus-extension-data-operations/src/migrations.js';
import { contentCollections } from '../src/data-model/content-collections.js';
import { toFieldPayload } from '../src/data-model/field-payloads.js';
import { toCollectionPayload } from '../src/data-model/install.js';
import { referenceCollections } from '../src/data-model/reference-collections.js';
import {
  aliasesFor,
  compositeKeys,
  relationsOf,
  toRelationPayload,
} from '../src/data-model/relations.js';
import { findCollection, findField } from './data-model-test-helpers.js';
import { fakeItemsDirectus } from './store-test-helpers.js';

// The teaching model in Studio and the database: a course's Status, and
// its staff links, each a required course, staff member and role, at most
// one per person, role and course.

const statusNote =
  'All professors publishes "Сите професори" as professors. Inactive publishes "(неактивиран предмет)" as professors and assistants.';

const uniqueLink =
  'CREATE UNIQUE INDEX IF NOT EXISTS "teaching_assignments_course_staff_role_unique" ON "teaching_assignments" ("course", "staff", "role")';

const aliasOf = (collection: 'courses' | 'staff', field: string) =>
  aliasesFor(collection).find(({ alias }) => alias.field === field);

// Posts the links to an in-memory store that enforces the model's
// composite keys as the database does.
const linked = async (
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
): Promise<unknown> => {
  const { request } = fakeItemsDirectus({
    items: new Map([['teaching_assignments', []]]),
  });
  try {
    await request('/items/teaching_assignments', {
      body: JSON.stringify(rows),
      method: 'POST',
    });
    return 'created';
  } catch (error) {
    return error;
  }
};

const link = (staff: number, role: string) => ({ course: 1, role, staff });

describe('the course status', () => {
  test('is a required dropdown of three labelled values, starting Active, labelled Status with its note', () => {
    const status = findField('courses', 'status');

    expect(status).toMatchObject({
      choices: [
        { label: 'Active', value: 'active' },
        { label: 'All professors', value: 'all_professors' },
        { label: 'Inactive', value: 'inactive' },
      ],
      defaultValue: 'active',
      kind: 'enum',
      label: 'Status',
      note: statusNote,
      nullable: false,
    });
    expect(toFieldPayload(status, 2)).toMatchObject({
      meta: {
        note: statusNote,
        required: true,
        translations: [{ language: 'en-US', translation: 'Status' }],
      },
      schema: { default_value: 'active', is_nullable: false },
    });
    expect(statusNote).toContain(`"${teachingTexts.allProfessors}"`);
    expect(statusNote).toContain(`"${teachingTexts.inactive}"`);
  });

  test('leaves no typed professors text on a course', () => {
    expect(findCollection('courses').fields.map(({ field }) => field)).toEqual([
      'name',
      'status',
      'tags',
      'discord_channel',
    ]);
  });
});

describe('the content collections', () => {
  test('carry no collection note, while a declared one is still written', () => {
    expect(
      [...contentCollections, ...referenceCollections]
        .filter(
          (collection) =>
            collection.note !== undefined ||
            Object.hasOwn(toCollectionPayload(collection).meta, 'note'),
        )
        .map(({ collection }) => collection),
    ).toEqual([]);

    const staging = findCollection('moodle_import_rows');

    expect(staging.note).toBeTypeOf('string');
    expect(toCollectionPayload(staging).meta).toHaveProperty(
      'note',
      staging.note,
    );
  });
});

describe('the staff links of a course', () => {
  test('require a course, a staff member and a role, and have no display text', () => {
    expect(
      findCollection('teaching_assignments').fields.map(
        ({ field, kind, nullable }) => [field, kind, nullable],
      ),
    ).toEqual([
      ['course', 'm2o', false],
      ['staff', 'm2o', false],
      ['role', 'enum', false],
      ['sort', 'integer', true],
    ]);

    const role = findField('teaching_assignments', 'role');

    expect(
      role.kind === 'enum' ? role.defaultValue : 'not an enum',
    ).toBeUndefined();
    expect(toFieldPayload(role, 3)).toMatchObject({
      meta: {
        required: true,
        validation: { role: { _in: ['professor', 'assistant'] } },
      },
      schema: { is_nullable: false },
    });
  });

  test('are deleted with their course or staff member, and when taken out of either list', () => {
    expect(
      relationsOf('teaching_assignments').map((relation) => {
        const { field, meta, related_collection, schema } =
          toRelationPayload(relation);
        return [field, related_collection, meta, schema.on_delete];
      }),
    ).toEqual([
      [
        'course',
        'courses',
        {
          junction_field: null,
          one_deselect_action: 'delete',
          one_field: 'assignments',
          sort_field: 'sort',
        },
        'CASCADE',
      ],
      [
        'staff',
        'staff',
        {
          junction_field: null,
          one_deselect_action: 'delete',
          one_field: 'assignments',
          sort_field: null,
        },
        'CASCADE',
      ],
    ]);
  });

  test('are labelled Teaching staff, listed by role and staff member, and Teaches on a staff member', () => {
    expect(findCollection('teaching_assignments').label).toEqual({
      plural: 'Teaching staff',
      singular: 'Teaching assignment',
    });
    expect(aliasOf('courses', 'assignments')).toMatchObject({
      alias: { fields: ['role', 'staff'], label: 'Teaching staff' },
      relation: { sortField: 'sort' },
    });
    expect(aliasOf('staff', 'assignments')).toMatchObject({
      alias: { fields: ['course', 'role'], label: 'Teaches' },
    });
  });

  test('are unique per course, staff member and role in SQL', () => {
    expect(
      compositeKeys.filter(
        ({ collection }) => collection === 'teaching_assignments',
      ),
    ).toEqual([
      {
        collection: 'teaching_assignments',
        columns: ['course', 'staff', 'role'],
        kind: 'unique',
        name: 'teaching_assignments_course_staff_role_unique',
      },
    ]);
    expect(schemaConstraints.statements).toContain(uniqueLink);
  });

  test('refuse a second link of a person in one role of a course, and allow both roles', async () => {
    await expect(
      linked([
        link(5, 'professor'),
        link(5, 'assistant'),
        link(6, 'professor'),
      ]),
    ).resolves.toBe('created');
    await expect(
      linked([link(5, 'professor'), link(5, 'professor')]),
    ).resolves.toMatchObject({
      code: 'RECORD_NOT_UNIQUE',
      status: 400,
    });
  });
});
