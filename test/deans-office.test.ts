import { describe, expect, test } from 'vitest';

import { exportDefinitions } from '../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { schemaConstraints } from '../directus/extensions/directus-extension-data-operations/src/migrations.js';
import { deanPositions } from '../src/data-model/choice-lists.js';
import {
  enumMaxLength,
  toAliasPayload,
  toFieldPayload,
} from '../src/data-model/field-payloads.js';
import { presetDefinitions } from '../src/data-model/presentation/presets.js';
import {
  aliasesFor,
  compositeKeys,
  findModelRelation,
  toRelationAlignmentPayload,
  toRelationPayload,
} from '../src/data-model/relations.js';
import { findCollection, findField } from './data-model-test-helpers.js';
import { effectiveFieldMeta } from './presentation-test-helpers.js';

// The dean's office: each term a year, a position from a closed list and
// the staff member who holds it, one holder per year and position.

const positions = [
  'Декан',
  'Продекан за настава',
  'Продекан за наука и соработка',
  'Продекан за финансии',
];

const holderLink = () => {
  const relation = findModelRelation('deans_office', 'staff');
  if (relation === undefined) {
    throw new Error('deans_office.staff is not a relation');
  }
  return relation;
};

describe("the dean's office", () => {
  test('holds a year, its staff member and a position, and no name', () => {
    expect(
      findCollection('deans_office').fields.map(({ field, kind, nullable }) => [
        field,
        kind,
        nullable,
      ]),
    ).toEqual([
      ['year', 'integer', false],
      ['staff', 'm2o', false],
      ['position', 'enum', false],
    ]);
  });

  test('offers the four positions only, labelled in English and refused otherwise', () => {
    expect(deanPositions).toEqual([
      { label: 'Dean', value: 'Декан' },
      { label: 'Vice-dean for teaching', value: 'Продекан за настава' },
      {
        label: 'Vice-dean for science and cooperation',
        value: 'Продекан за наука и соработка',
      },
      { label: 'Vice-dean for finance', value: 'Продекан за финансии' },
    ]);
    expect(findField('deans_office', 'position')).toMatchObject({
      choices: deanPositions,
      kind: 'enum',
      nullable: false,
    });
    expect(findField('deans_office', 'position')).not.toHaveProperty(
      'allowOther',
    );

    const payload = toFieldPayload(findField('deans_office', 'position'), 3);

    expect(payload).toMatchObject({
      meta: {
        interface: 'select-dropdown',
        options: { allowNone: false, allowOther: false },
        required: true,
        validation: { position: { _in: positions } },
      },
      schema: { is_nullable: false, max_length: enumMaxLength },
      type: 'string',
    });

    for (const value of positions) {
      expect(value.length).toBeLessThanOrEqual(enumMaxLength);
    }
  });

  test('requires the staff member of a term, picked by name', () => {
    expect(toFieldPayload(findField('deans_office', 'staff'), 2)).toMatchObject(
      {
        meta: {
          display: 'related-values',
          display_options: { template: '{{name}}' },
          interface: 'select-dropdown-m2o',
          options: { template: '{{name}}' },
          required: true,
        },
        schema: { is_nullable: false },
        type: 'integer',
      },
    );
  });

  test('refuses deleting a staff member who holds a term, and deletes a term taken out of the staff form', () => {
    expect(toRelationPayload(holderLink())).toEqual({
      collection: 'deans_office',
      field: 'staff',
      meta: {
        junction_field: null,
        one_deselect_action: 'delete',
        one_field: 'dean_terms',
        sort_field: null,
      },
      related_collection: 'staff',
      schema: { on_delete: 'NO ACTION' },
    });
    expect(toRelationAlignmentPayload(holderLink())).toMatchObject({
      meta: { one_deselect_action: 'delete', one_field: 'dean_terms' },
      schema: { on_delete: 'NO ACTION' },
    });
  });

  test("lists a staff member's terms by year and position on the staff form", () => {
    const aliases = aliasesFor('staff');

    expect(aliases.map(({ alias }) => alias.field)).toEqual([
      'assignments',
      'dean_terms',
    ]);

    const terms = aliases.find(({ alias }) => alias.field === 'dean_terms');

    expect(terms?.alias).toEqual({
      field: 'dean_terms',
      fields: ['year', 'position'],
      label: "Dean's office terms",
      template: '{{year}} {{position}}',
    });
    expect(terms && toAliasPayload(terms.alias, 11).meta).toMatchObject({
      interface: 'list-o2m',
      options: {
        fields: ['year', 'position'],
        template: '{{year}} {{position}}',
      },
      readonly: false,
    });
    expect(effectiveFieldMeta('staff', 'dean_terms')).toMatchObject({
      interface: 'list-o2m',
      readonly: false,
    });
  });

  test('keeps one holder per year and position, in the model and in the shipped SQL', () => {
    expect(
      compositeKeys.filter(({ collection }) => collection === 'deans_office'),
    ).toEqual([
      {
        collection: 'deans_office',
        columns: ['year', 'position'],
        kind: 'unique',
        name: 'deans_office_year_position_unique',
      },
    ]);
    expect(schemaConstraints.statements).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "deans_office_year_position_unique" ON "deans_office" ("year", "position")',
    );
  });

  test('names a term by its year, position and holder, and lists the newest year first', () => {
    expect(findCollection('deans_office').displayTemplate).toBe(
      '{{year}} {{position}}: {{staff.name}}',
    );
    expect(
      presetDefinitions.find(
        ({ bookmark, collection }) =>
          collection === 'deans_office' && bookmark === null,
      ),
    ).toMatchObject({
      layout_query: {
        tabular: {
          fields: ['year', 'position', 'staff'],
          sort: ['-year', 'position'],
        },
      },
    });
  });

  test('is read by no published file', () => {
    const reads = JSON.stringify(
      exportDefinitions.map((definition) => [
        definition.rows,
        definition.related,
      ]),
    );

    expect(reads).toContain('"collection":"staff"');
    expect(reads).not.toContain('deans_office');
    expect(reads).not.toContain('dean_terms');
  });
});
