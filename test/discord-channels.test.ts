import { describe, expect, test } from 'vitest';

import { exportDefinitions } from '../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { dataModelCollectionKeys } from '../src/data-model/collections.js';
import { contentCollections } from '../src/data-model/content-collections.js';
import {
  toAliasPayload,
  toFieldPayload,
} from '../src/data-model/field-payloads.js';
import { findFieldPatch } from '../src/data-model/presentation/fields.js';
import { fieldGroups } from '../src/data-model/presentation/groups.js';
import { presetDefinitions } from '../src/data-model/presentation/presets.js';
import { referenceCollections } from '../src/data-model/reference-collections.js';
import {
  aliasesFor,
  findModelRelation,
  toRelationAlignmentPayload,
  toRelationPayload,
} from '../src/data-model/relations.js';
import { findCollection } from './data-model-test-helpers.js';
import { effectiveFieldMeta } from './presentation-test-helpers.js';

// The Discord channels a course links to: the model, the relation both
// forms edit, and how Studio shows them.

const channelTemplate = '{{channel}} (semester {{semester}})';

const channelLink = () => {
  const relation = findModelRelation('courses', 'discord_channel');
  if (relation === undefined) {
    throw new Error('courses.discord_channel is not a relation');
  }
  return relation;
};

describe('the Discord channels', () => {
  test('are reference lists declared right after the content, in the same collection order', () => {
    expect(referenceCollections.map(({ collection }) => collection)).toEqual([
      'discord_channels',
      'student_council',
      'deans_office',
    ]);
    expect(
      dataModelCollectionKeys.slice(
        contentCollections.length,
        contentCollections.length + referenceCollections.length,
      ),
    ).toEqual(['discord_channels', 'student_council', 'deans_office']);
  });

  test('hold a semester of at least 1 and the alias, and no course names', () => {
    const { fields } = findCollection('discord_channels');

    expect(
      fields.map(({ field, kind, nullable }) => [field, kind, nullable]),
    ).toEqual([
      ['semester', 'integer', false],
      ['channel', 'string', false],
    ]);

    const [semester] = fields;
    if (semester === undefined) {
      throw new Error('discord_channels has no semester');
    }

    expect(toFieldPayload(semester, 1)).toMatchObject({
      meta: { required: true, validation: { semester: { _gte: 1 } } },
      schema: { is_nullable: false },
      type: 'integer',
    });
  });

  test('are linked from a course by an optional link that names the channel and its semester', () => {
    const field = findCollection('courses').fields.find(
      (candidate) => candidate.field === 'discord_channel',
    );
    if (field === undefined) {
      throw new Error('courses has no discord_channel');
    }

    expect(toFieldPayload(field, 4)).toMatchObject({
      meta: {
        display: 'related-values',
        display_options: { template: channelTemplate },
        interface: 'select-dropdown-m2o',
        options: { template: channelTemplate },
        required: false,
      },
      schema: { is_nullable: true },
      type: 'integer',
    });
  });

  test('clear the link when a channel is deleted or a course is taken out of its list', () => {
    expect(toRelationPayload(channelLink())).toEqual({
      collection: 'courses',
      field: 'discord_channel',
      meta: {
        junction_field: null,
        one_deselect_action: 'nullify',
        one_field: 'courses',
        sort_field: null,
      },
      related_collection: 'discord_channels',
      schema: { on_delete: 'SET NULL' },
    });
    expect(toRelationAlignmentPayload(channelLink())).toMatchObject({
      meta: { one_deselect_action: 'nullify', one_field: 'courses' },
      schema: { on_delete: 'SET NULL' },
    });
  });

  test('list their courses by name, picked from the existing courses and never created there', () => {
    const [alias, ...others] = aliasesFor('discord_channels');

    expect(others).toEqual([]);
    expect(alias?.alias).toEqual({
      field: 'courses',
      fields: ['name'],
      label: 'Courses',
      template: '{{name}}',
    });
    // The installer writes the usual editable list; presentation then
    // turns off creating a course from the channel form.
    expect(alias && toAliasPayload(alias.alias, 3).meta.options).toMatchObject({
      enableCreate: true,
    });
    expect(findFieldPatch('discord_channels', 'courses')?.meta).toMatchObject({
      options: { enableCreate: false },
    });
    expect(effectiveFieldMeta('discord_channels', 'courses')).toMatchObject({
      interface: 'list-o2m',
      options: {
        enableCreate: false,
        enableLink: true,
        enableSelect: true,
        fields: ['name'],
        template: '{{name}}',
      },
      readonly: false,
    });
  });

  test("show the course's channel in the course form's first group", () => {
    expect(
      fieldGroups.find(
        ({ collection, field }) =>
          collection === 'courses' && field === 'overview',
      )?.members,
    ).toEqual(['name', 'tags', 'discord_channel']);
    expect(effectiveFieldMeta('courses', 'discord_channel')).toMatchObject({
      group: 'overview',
      sort: 3,
    });
  });

  test('list by semester and alias, with their courses, in the default view', () => {
    expect(
      presetDefinitions.find(
        ({ bookmark, collection }) =>
          collection === 'discord_channels' && bookmark === null,
      ),
    ).toMatchObject({
      layout_query: {
        tabular: {
          fields: ['semester', 'channel', 'courses'],
          sort: ['semester', 'channel'],
        },
      },
    });
  });

  test('are read by no published file', () => {
    const reads = JSON.stringify(
      exportDefinitions.map((definition) => [
        definition.rows,
        definition.related,
      ]),
    );

    expect(reads).toContain('"collection":"courses","fields":["id","name"');
    expect(reads).not.toContain('discord');
  });
});
