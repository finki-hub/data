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

// The Discord channels of the courses: the model, the junction both forms
// edit, and how Studio shows them.

const channelTemplate = '{{channel}} (semester {{semester}})';

const junctionLink = (field: 'course' | 'discord_channel') => {
  const relation = findModelRelation('discord_channel_courses', field);
  if (relation === undefined) {
    throw new Error(`discord_channel_courses.${field} is not a relation`);
  }
  return relation;
};

describe('the Discord channels', () => {
  test('are reference lists declared right after the content, with their junction, in the same collection order', () => {
    const order = [
      'discord_channels',
      'discord_channel_courses',
      'student_council',
      'deans_office',
    ];

    expect(referenceCollections.map(({ collection }) => collection)).toEqual(
      order,
    );
    expect(
      dataModelCollectionKeys.slice(
        contentCollections.length,
        contentCollections.length + referenceCollections.length,
      ),
    ).toEqual(order);
    expect(findCollection('discord_channel_courses').hidden).toBeTruthy();
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

  test('link to their courses through a junction whose two required links name the channel and the course', () => {
    expect(findCollection('courses').fields.map(({ field }) => field)).toEqual([
      'name',
      'abbreviation',
      'status',
      'tags',
    ]);

    const [channel, course] = findCollection('discord_channel_courses').fields;
    if (channel === undefined || course === undefined) {
      throw new Error('discord_channel_courses lacks its links');
    }

    expect(toFieldPayload(channel, 1)).toMatchObject({
      meta: {
        display_options: { template: channelTemplate },
        interface: 'select-dropdown-m2o',
        required: true,
      },
      schema: { is_nullable: false },
      type: 'integer',
    });
    expect(toFieldPayload(course, 2)).toMatchObject({
      meta: { display_options: { template: '{{name}}' }, required: true },
      schema: { is_nullable: false },
      type: 'integer',
    });
  });

  test('drop a junction row with either of its rows, or when it is taken out of a list', () => {
    expect(toRelationPayload(junctionLink('discord_channel'))).toEqual({
      collection: 'discord_channel_courses',
      field: 'discord_channel',
      meta: {
        junction_field: 'course',
        one_deselect_action: 'delete',
        one_field: 'courses',
        sort_field: null,
      },
      related_collection: 'discord_channels',
      schema: { on_delete: 'CASCADE' },
    });
    expect(toRelationPayload(junctionLink('course'))).toEqual({
      collection: 'discord_channel_courses',
      field: 'course',
      meta: {
        junction_field: 'discord_channel',
        one_deselect_action: 'delete',
        one_field: 'discord_channels',
        sort_field: null,
      },
      related_collection: 'courses',
      schema: { on_delete: 'CASCADE' },
    });
    expect(toRelationAlignmentPayload(junctionLink('course'))).toMatchObject({
      meta: { one_deselect_action: 'delete', one_field: 'discord_channels' },
      schema: { on_delete: 'CASCADE' },
    });
  });

  test('list their courses by name, and a course its channels, picked from the existing rows and never created there', () => {
    const [alias, ...others] = aliasesFor('discord_channels');

    expect(others).toEqual([]);
    expect(alias?.alias).toEqual({
      field: 'courses',
      fields: ['course'],
      junction: 'course',
      label: 'Courses',
      template: '{{course.name}}',
    });
    expect(alias && toAliasPayload(alias.alias, 3).meta).toMatchObject({
      interface: 'list-m2m',
      options: { enableCreate: false, enableSelect: true },
      special: ['m2m'],
    });
    expect(findFieldPatch('discord_channels', 'courses')?.meta).toMatchObject({
      options: { enableCreate: false },
    });
    expect(effectiveFieldMeta('discord_channels', 'courses')).toMatchObject({
      interface: 'list-m2m',
      options: {
        enableCreate: false,
        enableLink: true,
        enableSelect: true,
        fields: ['course'],
        template: '{{course.name}}',
      },
      readonly: false,
    });
    expect(effectiveFieldMeta('courses', 'discord_channels')).toMatchObject({
      interface: 'list-m2m',
      options: {
        enableCreate: false,
        enableSelect: true,
        template:
          '{{discord_channel.channel}} (semester {{discord_channel.semester}})',
      },
      readonly: false,
    });
  });

  test("show the course's channels in the course form's first group", () => {
    expect(
      fieldGroups.find(
        ({ collection, field }) =>
          collection === 'courses' && field === 'overview',
      )?.members,
    ).toEqual(['name', 'abbreviation', 'tags', 'discord_channels']);
    expect(effectiveFieldMeta('courses', 'discord_channels')).toMatchObject({
      group: 'overview',
      sort: 4,
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
