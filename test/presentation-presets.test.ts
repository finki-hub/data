import { describe, expect, test } from 'vitest';

import type {
  PresetDefinition,
  TabularPreset,
} from '../src/data-model/presentation/preset-schema.js';

import {
  curriculumBookmark,
  presetDefinitions,
  reviewPresets,
  searchBookmark,
} from '../src/data-model/presentation/presets.js';
import { resolves } from './presentation-test-helpers.js';

// The shared presets the presentation declares: the default table views,
// the curriculum bookmark, the Needs review bookmarks and Search.

const isTabular = (preset: PresetDefinition): preset is TabularPreset =>
  preset.layout === 'tabular';

// The default table view of a collection.
const defaultViewOf = (collection: string) =>
  presetDefinitions
    .filter(isTabular)
    .find(
      (preset) => preset.bookmark === null && preset.collection === collection,
    );

const unresolvedPresetPaths = presetDefinitions
  .filter(isTabular)
  .flatMap((preset) =>
    [...preset.layout_query.tabular.fields, ...preset.layout_query.tabular.sort]
      .filter((path) => !resolves(preset.collection, path))
      .map((path) => `${preset.collection}: ${path}`),
  );

describe('presets', () => {
  test('defines one curriculum bookmark, narrowed by the native generation filter, and none per generation', () => {
    expect(curriculumBookmark).toMatchObject({
      bookmark: 'Curriculum by generation',
      collection: 'curriculum_entries',
      filter: null,
      role: null,
      user: null,
    });
    expect(curriculumBookmark.layout_query.tabular.sort).toEqual([
      'generation',
      'catalog_order',
    ]);
    expect(curriculumBookmark.layout_query.tabular.fields[0]).toBe(
      'generation',
    );
    expect(
      presetDefinitions.filter(
        ({ bookmark, collection }) =>
          collection === 'curriculum_entries' && bookmark !== null,
      ),
    ).toEqual([curriculumBookmark]);
    // No bookmark names a generation row: a new row needs none.
    expect(
      presetDefinitions.filter(({ filter }) =>
        JSON.stringify(filter ?? {}).includes('"generation":{"_eq"'),
      ),
    ).toEqual([]);
  });

  test('declares no shared bookmark beyond the curriculum one, the registry review views and Search', () => {
    expect(
      presetDefinitions.filter(({ bookmark }) => bookmark !== null),
    ).toEqual([curriculumBookmark, ...reviewPresets(), searchBookmark]);
  });

  test('keeps the Moodle users main table and the Search bookmark of directus/presets/course-search.json', () => {
    expect(defaultViewOf('moodle_users')).toMatchObject({
      layout_options: { tabular: { spacing: 'comfortable' } },
      layout_query: {
        tabular: {
          fields: [
            'Name',
            'Mail',
            'ID_new',
            'ID_old',
            'Courses Count',
            'Courses',
          ],
          sort: ['Name'],
        },
      },
    });
    expect(searchBookmark).toEqual({
      bookmark: 'Search',
      collection: 'moodle_users',
      filter: null,
      icon: 'person_search',
      layout: 'finki-hub-course-search',
      layout_options: {},
      layout_query: {},
      role: null,
      search: null,
      user: null,
    });
  });

  test('shows both instance ids in the staged Moodle rows view, so a row without ID_new shows its ID_old', () => {
    expect(
      defaultViewOf('moodle_import_rows')?.layout_query.tabular,
    ).toMatchObject({
      fields: ['Name', 'Mail', 'ID_old', 'ID_new', 'Courses Count'],
      sort: ['Name'],
    });
  });

  test('gives every directory a default table view', () => {
    expect(
      ['staff', 'rooms', 'students', 'discord_channels', 'deans_office'].map(
        (collection) => [
          collection,
          defaultViewOf(collection)?.layout_query.tabular.sort,
        ],
      ),
    ).toEqual([
      ['staff', ['name']],
      ['rooms', ['location']],
      ['students', ['-source_group']],
      ['discord_channels', ['semester']],
      ['deans_office', ['-year']],
    ]);
  });

  test('lists curriculum entries without a level column, in the default view and the curriculum bookmark', () => {
    expect(
      defaultViewOf('curriculum_entries')?.layout_query.tabular.fields,
    ).toEqual(['generation', 'code', 'name', 'semester', 'channel']);
    expect(curriculumBookmark.layout_query.tabular.fields).toEqual([
      'generation',
      'code',
      'name',
      'semester',
      'channel',
      'course_links',
    ]);
  });

  test('shows a course with its status, tags, curriculum links and assignments in the default Courses view', () => {
    expect(defaultViewOf('courses')?.layout_query.tabular.fields).toEqual([
      'name',
      'status',
      'tags',
      'curricula',
      'assignments',
    ]);
  });

  test('lists only fields that exist on the collection or its relation targets', () => {
    expect(unresolvedPresetPaths).toEqual([]);

    const defaults = presetDefinitions.filter(
      ({ bookmark }) => bookmark === null,
    );

    expect(new Set(defaults.map(({ collection }) => collection)).size).toBe(
      defaults.length,
    );
    expect(defaults.map(({ collection }) => collection)).not.toContain(
      'data_operations',
    );
  });
});
