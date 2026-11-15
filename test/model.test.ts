import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { sourceDeclarations } from '../directus/extensions/directus-extension-data-operations/src/coordination/collection-roles.js';
import { dataModelCollections } from '../src/data-model/collections.js';
import { aliasesFor } from '../src/data-model/relations.js';
import { effectiveFieldMeta } from './presentation-test-helpers.js';

const collectionIcon = (key: string): string | undefined =>
  dataModelCollections.find(({ collection }) => collection === key)?.icon;

const relational = z.looseObject({
  display: z.literal('related-values'),
  interface: z.string(),
  options: z.looseObject({
    enableCreate: z.boolean(),
    enableSelect: z.boolean(),
    fields: z.array(z.string()).optional(),
    template: z.string().min(1),
  }),
  readonly: z.boolean(),
});

const plain = z.looseObject({
  interface: z.string().min(1),
  readonly: z.boolean(),
});

const modelFields = dataModelCollections.flatMap((collection) =>
  collection.fields.map((field) => ({
    collection: collection.collection,
    field: field.field,
    kind: field.kind,
    readOnly: field.readOnly === true,
    related: field.kind === 'm2o' ? field.related : null,
  })),
);

// True when every column of the collection is owned by the Flows (the
// history lines too: the index writes both their columns).
const isDerived = (collection: string): boolean =>
  dataModelCollections
    .find((candidate) => candidate.collection === collection)
    ?.fields.every(({ readOnly }) => readOnly === true) === true;

const aliasMetas = dataModelCollections.flatMap((collection) =>
  aliasesFor(collection.collection).map(({ alias, relation }) => ({
    derivedTarget: isDerived(relation.collection),
    field: `${collection.collection}.${alias.field}`,
    junction: alias.junction !== undefined,
    meta: relational.parse(
      effectiveFieldMeta(collection.collection, alias.field),
    ),
    readOnly: alias.readOnly === true,
  })),
);

describe('collection icons', () => {
  test('uses the curriculum icon for the curriculum entries', () => {
    expect(collectionIcon('curriculum_entries')).toBe('menu_book');
  });

  test('uses a single-person icon for Moodle users', () => {
    expect(collectionIcon('moodle_users')).toBe('person');
  });
});

describe('studio metadata', () => {
  test('gives every editable source field an interface and every relation a readable template', () => {
    expect(modelFields.length).toBeGreaterThan(0);

    // Read-only in Studio: exactly the columns the model declares so.
    expect(
      modelFields.filter(
        ({ collection, field, readOnly }) =>
          plain.parse(effectiveFieldMeta(collection, field)).readonly !==
          readOnly,
      ),
    ).toEqual([]);

    const selectors = modelFields
      .filter(
        ({ kind, related }) => kind === 'm2o' && related !== 'directus_files',
      )
      .map(
        ({ collection, field }) =>
          relational.parse(effectiveFieldMeta(collection, field)).interface,
      );

    expect(new Set(selectors)).toEqual(new Set(['select-dropdown-m2o']));
    expect(
      aliasMetas.filter(
        ({ junction, meta }) =>
          meta.interface !== (junction ? 'list-m2m' : 'list-o2m') ||
          (meta.options.fields ?? []).length === 0,
      ),
    ).toEqual([]);
  });

  test('shows derived collections as read-only rows that Studio cannot add to', () => {
    const owned = dataModelCollections
      .filter(({ collection }) => isDerived(collection))
      .map(({ collection }) => collection);

    expect(owned).toEqual([
      'moodle_course_entries',
      'moodle_history_memberships',
      'moodle_counted_lines',
      'data_operation_matches',
      'course_enrollments',
      'timetables',
      'timetable_lessons',
      'course_teaching',
    ]);

    // The history lines are the one source among them: Studio edits their
    // explicit mappings and may delete a line, never a column of it.
    const sources = new Set<string>(
      sourceDeclarations.map(({ collection }) => collection),
    );

    expect(owned.filter((collection) => sources.has(collection))).toEqual([
      'moodle_course_entries',
    ]);

    // A many-to-many list picks existing rows (study programs) and never
    // creates one from the other side; so does a channel's list of courses.
    const selectOnly = new Set(['discord_channels.courses']);

    expect(
      aliasMetas.filter(
        ({ derivedTarget, field, junction, meta, readOnly }) =>
          readOnly !== derivedTarget ||
          meta.readonly !== derivedTarget ||
          meta.options.enableCreate !==
            (!derivedTarget && !junction && !selectOnly.has(field)) ||
          meta.options.enableSelect === derivedTarget,
      ),
    ).toEqual([]);
  });
});
