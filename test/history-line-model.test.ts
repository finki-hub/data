import { describe, expect, test } from 'vitest';

import type { ModelCollectionKey } from '../src/schema.js';

import { dataModelCollections } from '../src/data-model/collections.js';
import {
  toAliasPayload,
  toFieldPayload,
} from '../src/data-model/field-payloads.js';
import { toCollectionPayload } from '../src/data-model/install.js';
import { fieldPresentations } from '../src/data-model/presentation/fields.js';
import { fieldGroups } from '../src/data-model/presentation/groups.js';
import { aliasesFor } from '../src/data-model/relations.js';
import { findCollection, findField } from './data-model-test-helpers.js';
import { effectiveFieldMeta } from './presentation-test-helpers.js';

// The history line model in Studio: a line is its exact label and the time
// the history index first created it, with no review state; its explicit
// mappings are labelled as such, and the line's list of them says that one
// replaces every pattern for the line. The form and a user's history show
// where each line is counted.

const firstSeenNote = 'When the history index first created this line.';
const explicit = 'Explicit mappings';
const explicitNote =
  'An explicit mapping replaces every pattern for this line.';

const aliasOf = (collection: ModelCollectionKey, field: string) => {
  const found = aliasesFor(collection).find(
    ({ alias }) => alias.field === field,
  );
  if (found === undefined) {
    throw new Error(`Alias ${collection}.${field} is not part of the model`);
  }
  return found.alias;
};

const translation = (label: string) => [
  { language: 'en-US', translation: label },
];

describe('a history line', () => {
  test('is its exact label and a nullable, read-only First seen, without a review state', () => {
    expect(
      findCollection('moodle_course_entries').fields.map(
        ({ field, kind, nullable }) => [field, kind, nullable],
      ),
    ).toEqual([
      ['label', 'text', false],
      ['first_seen', 'timestamp', true],
    ]);
    expect(findField('moodle_course_entries', 'first_seen')).toEqual({
      field: 'first_seen',
      kind: 'timestamp',
      label: 'First seen',
      note: firstSeenNote,
      nullable: true,
      readOnly: true,
    });
  });

  test('installs First seen as a read-only date and time with its label and note, and no default', () => {
    const payload = toFieldPayload(
      findField('moodle_course_entries', 'first_seen'),
      2,
    );

    expect(payload).toEqual({
      field: 'first_seen',
      meta: {
        display: 'datetime',
        interface: 'datetime',
        note: firstSeenNote,
        readonly: true,
        required: false,
        sort: 2,
        translations: translation('First seen'),
        width: 'half',
      },
      schema: { is_nullable: true },
      type: 'timestamp',
    });
  });

  test('is named History lines, without a collection note', () => {
    const { meta } = toCollectionPayload(
      findCollection('moodle_course_entries'),
    );

    expect(meta).toMatchObject({
      translations: [
        {
          language: 'en-US',
          plural: 'History lines',
          singular: 'History line',
          translation: 'History lines',
        },
      ],
    });
    expect(Object.hasOwn(meta, 'note')).toBe(false);
  });

  test('lists its Explicit mappings with the note that one replaces every pattern for the line', () => {
    const mappings = aliasOf('moodle_course_entries', 'mappings');

    expect(mappings).toMatchObject({
      label: explicit,
      note: explicitNote,
    });
    expect(toAliasPayload(mappings, 4).meta).toMatchObject({
      note: explicitNote,
      translations: translation(explicit),
    });
  });

  test('shows a user the courses and years each line is counted for, never a review state', () => {
    expect(aliasOf('moodle_users', 'history_memberships').fields).toEqual([
      'entry',
      'entry.counted_for.course',
      'entry.counted_for.academic_year',
      'sort',
    ]);
  });
});

describe('explicit mappings', () => {
  test('are named Explicit mappings, without a collection note', () => {
    const { meta } = toCollectionPayload(
      findCollection('moodle_course_mappings'),
    );

    expect(meta).toMatchObject({
      translations: [
        {
          language: 'en-US',
          plural: explicit,
          singular: 'Explicit mapping',
          translation: explicit,
        },
      ],
    });
    expect(Object.hasOwn(meta, 'note')).toBe(false);
  });

  test('carry the same label on the line, the course and the academic year', () => {
    expect(
      [
        aliasOf('moodle_course_entries', 'mappings'),
        aliasOf('courses', 'history_mappings'),
        aliasOf('academic_years', 'mappings'),
      ].map(({ label }) => label),
    ).toEqual([explicit, explicit, explicit]);
  });
});

// Every alias of the model with its collection.
const everyAlias = dataModelCollections.flatMap(({ collection }) =>
  aliasesFor(collection).map(({ alias }) => ({ alias, collection })),
);

describe('alias notes', () => {
  test("are sent exactly where the model declares one: on a course's pattern mappings and a line's explicit mappings", () => {
    const noted = everyAlias
      .filter(({ alias }) =>
        Object.hasOwn(toAliasPayload(alias, 1).meta, 'note'),
      )
      .map(({ alias, collection }) => `${collection}.${alias.field}`);

    expect(noted).toEqual([
      'courses.pattern_mappings',
      'moodle_course_entries.mappings',
    ]);
  });
});

describe('the history line form', () => {
  test('shows the label and First seen, then the explicit mappings, then where the line counts and its users read-only, without a group note', () => {
    expect(
      fieldGroups
        .filter(({ collection }) => collection === 'moodle_course_entries')
        .map(({ field, members, note, readOnly, sort }) => ({
          field,
          members,
          note,
          readOnly,
          sort,
        })),
    ).toEqual([
      {
        field: 'line',
        members: ['label', 'first_seen'],
        note: undefined,
        readOnly: undefined,
        sort: 1,
      },
      {
        field: 'mapping',
        members: ['mappings'],
        note: undefined,
        readOnly: undefined,
        sort: 2,
      },
      {
        field: 'counting',
        members: ['counted_for'],
        note: undefined,
        readOnly: true,
        sort: 3,
      },
      {
        field: 'usage',
        members: ['memberships'],
        note: undefined,
        readOnly: true,
        sort: 4,
      },
    ]);
  });

  test('keeps the model notes of First seen and the explicit mappings, read-only First seen', () => {
    expect(
      effectiveFieldMeta('moodle_course_entries', 'first_seen'),
    ).toMatchObject({
      group: 'line',
      interface: 'datetime',
      note: 'When the history index first created this line.',
      readonly: true,
    });
    expect(
      effectiveFieldMeta('moodle_course_entries', 'mappings'),
    ).toMatchObject({
      group: 'mapping',
      note: 'An explicit mapping replaces every pattern for this line.',
    });
    expect(
      fieldPresentations
        .filter(({ collection }) => collection === 'moodle_course_entries')
        .map(({ field }) => field),
    ).toEqual(['memberships']);
  });

  test('lists the courses and years the line is counted for, open and read-only', () => {
    expect(
      effectiveFieldMeta('moodle_course_entries', 'counted_for'),
    ).toMatchObject({
      group: 'counting',
      options: {
        enableSearchFilter: true,
        fields: ['course', 'academic_year', 'source'],
      },
      readonly: true,
      sort: 1,
      translations: translation('Counted for'),
    });
    expect(
      fieldGroups.find(
        ({ collection, field }) =>
          collection === 'moodle_course_entries' && field === 'counting',
      )?.start,
    ).toBe('open');
  });
});
