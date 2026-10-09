import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type {
  ModelCollection,
  ModelCollectionKey,
  ModelField,
} from '../src/schema.js';

import { dataModelCollections } from '../src/data-model/collections.js';
import {
  toAliasPayload,
  toFieldPayload,
} from '../src/data-model/field-payloads.js';
import {
  installDataModel,
  toCollectionPayload,
} from '../src/data-model/install.js';
import { aliasesFor } from '../src/data-model/relations.js';
import {
  collectionTranslations,
  fieldTranslations,
} from '../src/data-model/translations.js';
import {
  emptyState,
  fakeDirectus,
  findCollection,
  findField,
  mutations,
} from './data-model-test-helpers.js';

// A declared label is the English (en-US) name Studio shows for a
// collection, field or alias. The payloads carry `meta.translations` exactly
// when a label is declared.

const absent = 'no translations key';

const translationsOf = (meta: Readonly<Record<string, unknown>>): unknown =>
  Object.hasOwn(meta, 'translations') ? meta['translations'] : absent;

const withLabel = (field: ModelField, label: string): ModelField => ({
  ...field,
  label,
});

const aliasOf = (collection: ModelCollectionKey, field: string) => {
  const found = aliasesFor(collection).find(
    ({ alias }) => alias.field === field,
  );
  if (found === undefined) {
    throw new Error(`Alias ${collection}.${field} is not part of the model`);
  }
  return found.alias;
};

const collectionBody = z.object({
  collection: z.string(),
  fields: z.array(
    z.object({
      field: z.string(),
      meta: z.record(z.string(), z.unknown()),
    }),
  ),
  meta: z.record(z.string(), z.unknown()),
});

// The translations a payload sends for each unlabelled field and alias of a
// collection.
const unlabelledTranslations = ({
  collection,
  fields,
}: ModelCollection): unknown[] => [
  ...fields.flatMap((field, index) =>
    field.label === undefined
      ? [translationsOf(toFieldPayload(field, index + 1).meta)]
      : [],
  ),
  ...aliasesFor(collection).flatMap(({ alias }) =>
    alias.label === undefined
      ? [translationsOf(toAliasPayload(alias, 1).meta)]
      : [],
  ),
];

// What a `POST /collections` body sends: its translations, then per field
// and alias in payload order.
const sentTranslations = (body: unknown) => {
  const parsed = collectionBody.parse(body);
  return {
    collection: parsed.collection,
    fields: parsed.fields.map(({ field, meta }) => [
      field,
      translationsOf(meta),
    ]),
    translations: translationsOf(parsed.meta),
  };
};

// What the model declares: per collection its translations, then per field
// and alias in payload order.
const declaredTranslations = (collection: ModelCollection) => ({
  collection: collection.collection,
  fields: [
    ...collection.fields.map(({ field, label }) => [
      field,
      label === undefined ? absent : fieldTranslations(label),
    ]),
    ...aliasesFor(collection.collection).map(({ alias }) => [
      alias.field,
      alias.label === undefined ? absent : fieldTranslations(alias.label),
    ]),
  ],
  translations:
    collection.label === undefined
      ? absent
      : collectionTranslations(collection.label),
});

// Every label a collection declares, for itself, its fields and its
// aliases, as `<collection>[.<field>]: <label>`.
const declaredLabels = ({ collection, fields, label }: ModelCollection) => [
  ...(label === undefined
    ? []
    : [`${collection}: ${label.plural} / ${label.singular}`]),
  ...fields.flatMap((field) =>
    field.label === undefined
      ? []
      : [`${collection}.${field.field}: ${field.label}`],
  ),
  ...aliasesFor(collection).flatMap(({ alias }) =>
    alias.label === undefined
      ? []
      : [`${collection}.${alias.field}: ${alias.label}`],
  ),
];

describe('field and alias labels', () => {
  // One noted field of each kind: string, boolean, enum, relation and a
  // read-only JSON column.
  test.each([
    ['curriculum_entries', 'code'],
    ['academic_years', 'published'],
    ['data_operations', 'publication_state'],
    ['curriculum_entries', 'generation'],
    ['data_operations', 'publication_outcomes'],
  ])(
    'adds the en-US translation of a label to the payload of %s.%s and changes nothing else',
    (collection, field) => {
      const plain = toFieldPayload(findField(collection, field), 3);

      expect(
        toFieldPayload(withLabel(findField(collection, field), 'Label'), 3),
      ).toEqual({
        ...plain,
        meta: {
          ...plain.meta,
          translations: [{ language: 'en-US', translation: 'Label' }],
        },
      });
      expect(plain.meta.note).toBeTypeOf('string');
      expect(translationsOf(plain.meta)).toBe(absent);
    },
  );

  test('adds the en-US translation of a label to an alias payload and changes nothing else', () => {
    const alias = aliasOf('courses', 'curricula');
    const plain = toAliasPayload(alias, 9);

    expect(toAliasPayload({ ...alias, label: 'Curriculum links' }, 9)).toEqual({
      ...plain,
      meta: {
        ...plain.meta,
        translations: [{ language: 'en-US', translation: 'Curriculum links' }],
      },
    });
    expect(translationsOf(plain.meta)).toBe(absent);
  });

  test('sends no translations for a field or alias without a label', () => {
    const unlabelled = dataModelCollections.flatMap(unlabelledTranslations);

    expect(unlabelled.length).toBeGreaterThan(0);
    expect(new Set(unlabelled)).toEqual(new Set([absent]));
  });

  test('labels only the course status, the teaching staff links, the history lines, the explicit and pattern mappings and the counted lines', () => {
    expect(dataModelCollections.flatMap(declaredLabels)).toEqual([
      'courses.status: Status',
      'courses.assignments: Teaching staff',
      'courses.history_mappings: Explicit mappings',
      'courses.pattern_mappings: Pattern mappings',
      'courses.counted_lines: Counted lines',
      'staff.assignments: Teaches',
      'teaching_assignments: Teaching staff / Teaching assignment',
      'academic_years.mappings: Explicit mappings',
      'academic_years.pattern_mappings: Pattern mappings',
      'moodle_course_entries: History lines / History line',
      'moodle_course_entries.first_seen: First seen',
      'moodle_course_entries.mappings: Explicit mappings',
      'moodle_course_entries.counted_for: Counted for',
      'moodle_course_mappings: Explicit mappings / Explicit mapping',
      'moodle_pattern_mappings: Pattern mappings / Pattern mapping',
      'moodle_pattern_mappings.pattern: Pattern',
      'moodle_pattern_mappings.year_pattern: Year pattern',
      'moodle_pattern_mappings.only_in_year: Only in year',
      'moodle_pattern_mappings.counted_lines: Lines it counts',
      'moodle_counted_lines: Counted lines / Counted line',
    ]);
  });
});

describe('collection labels', () => {
  test('names a labelled collection by its plural, with its singular and plural, in en-US', () => {
    const courses = findCollection('courses');
    const plain = toCollectionPayload(courses);

    expect(
      toCollectionPayload({
        ...courses,
        label: { plural: 'Course list', singular: 'Course item' },
      }),
    ).toEqual({
      ...plain,
      meta: {
        ...plain.meta,
        translations: [
          {
            language: 'en-US',
            plural: 'Course list',
            singular: 'Course item',
            translation: 'Course list',
          },
        ],
      },
    });
    expect(translationsOf(plain.meta)).toBe(absent);
  });

  test('carries the labels of its fields inline', () => {
    const courses = findCollection('courses');
    const payload = toCollectionPayload({
      ...courses,
      fields: courses.fields.map((field) =>
        field.field === 'name' ? withLabel(field, 'Course name') : field,
      ),
    });
    const labels = new Map([
      ['assignments', 'Teaching staff'],
      ['counted_lines', 'Counted lines'],
      ['history_mappings', 'Explicit mappings'],
      ['name', 'Course name'],
      ['pattern_mappings', 'Pattern mappings'],
      ['status', 'Status'],
    ]);

    expect(
      payload.fields.map(({ field, meta }) => [field, translationsOf(meta)]),
    ).toEqual(
      [
        ...courses.fields.map(({ field }) => field),
        ...aliasesFor('courses').map(({ alias }) => alias.field),
      ].map((field) => {
        const label = labels.get(field);
        return [
          field,
          label === undefined
            ? absent
            : [{ language: 'en-US', translation: label }],
        ];
      }),
    );
  });

  test('sends a translation in the install payloads exactly where the model declares a label', async () => {
    const { request, requests } = fakeDirectus(emptyState());

    await installDataModel(request);

    const sent = mutations(requests)
      .filter(({ pathname }) => pathname === '/collections')
      .map(({ body }) => sentTranslations(body));

    expect(sent).toEqual(dataModelCollections.map(declaredTranslations));
  });
});
