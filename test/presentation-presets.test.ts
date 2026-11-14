import { describe, expect, test } from 'vitest';

import type {
  PresetDefinition,
  TabularPreset,
} from '../src/data-model/presentation/preset-schema.js';

import {
  searchBookmark,
  unmappedLinesBookmark,
} from '../src/data-model/presentation/bookmarks.js';
import { presetDefinitions } from '../src/data-model/presentation/presets.js';
import { resolves } from './presentation-test-helpers.js';

// The shared presets setup installs: the default table views, Search and
// Unmapped history lines.

const isTabular = (preset: PresetDefinition): preset is TabularPreset =>
  preset.layout === 'tabular';

// The default table view of a collection.
const defaultViewOf = (collection: string) =>
  presetDefinitions
    .filter(isTabular)
    .find(
      (preset) => preset.bookmark === null && preset.collection === collection,
    );

// The paths of every tabular preset setup creates.
const unresolvedPresetPaths = presetDefinitions
  .filter(isTabular)
  .flatMap((preset) =>
    [...preset.layout_query.tabular.fields, ...preset.layout_query.tabular.sort]
      .filter((path) => !resolves(preset.collection, path))
      .map((path) => `${preset.collection}: ${path}`),
  );

describe('presets', () => {
  test('declares Search and Unmapped history lines as its only shared bookmarks, and none per generation', () => {
    expect(
      presetDefinitions.filter(({ bookmark }) => bookmark !== null),
    ).toEqual([searchBookmark, unmappedLinesBookmark]);
    // No preset names a generation row: a new row needs none.
    expect(
      presetDefinitions.filter(({ filter }) =>
        JSON.stringify(filter ?? {}).includes('"generation":{"_eq"'),
      ),
    ).toEqual([]);
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
      ['discord_channels', ['semester', 'channel']],
      ['deans_office', ['-year', 'position']],
    ]);
  });

  test('lists curriculum entries generation first in catalog order, with their linked courses and without a level column', () => {
    expect(
      defaultViewOf('curriculum_entries')?.layout_query.tabular,
    ).toMatchObject({
      fields: [
        'generation',
        'code',
        'name',
        'semester',
        'channel',
        'course_links',
      ],
      sort: ['generation', 'catalog_order'],
    });
    expect(
      presetDefinitions.filter(
        ({ bookmark, collection }) =>
          collection === 'curriculum_entries' && bookmark !== null,
      ),
    ).toEqual([]);
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

  test('lists teaching links by course, role and staff member in the default Teaching staff view', () => {
    expect(
      defaultViewOf('teaching_assignments')?.layout_query.tabular,
    ).toMatchObject({
      fields: ['course', 'role', 'staff'],
      sort: ['course', 'sort'],
    });
  });

  test('lists history lines by label with their First seen', () => {
    expect(
      defaultViewOf('moodle_course_entries')?.layout_query.tabular,
    ).toMatchObject({ fields: ['label', 'first_seen'], sort: ['label'] });
    expect(
      presetDefinitions
        .filter(
          ({ bookmark, collection }) =>
            collection === 'moodle_course_entries' && bookmark !== null,
        )
        .map(({ bookmark }) => bookmark),
    ).toEqual(['Unmapped history lines']);
  });

  test('declares Unmapped history lines once: the lines without a counted line, newest First seen first', () => {
    expect(unmappedLinesBookmark).toEqual({
      bookmark: 'Unmapped history lines',
      collection: 'moodle_course_entries',
      filter: { counted_for: { id: { _null: true } } },
      icon: 'link_off',
      layout: 'tabular',
      layout_options: { tabular: { spacing: 'comfortable' } },
      layout_query: {
        tabular: {
          fields: ['label', 'first_seen'],
          limit: 50,
          page: 1,
          sort: ['-first_seen', 'label'],
        },
      },
      role: null,
      search: null,
      user: null,
    });
    expect(
      presetDefinitions.filter(
        ({ bookmark }) => bookmark === unmappedLinesBookmark.bookmark,
      ),
    ).toEqual([unmappedLinesBookmark]);
    // The filter goes through the line's Counted for list.
    expect(resolves('moodle_course_entries', 'counted_for.id')).toBeTruthy();
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

describe('the default views of the key sources and equivalency members', () => {
  test('orders years and generations newest first by their text, programs by code and equivalency members by generation, with no sort column', () => {
    expect(
      [
        'academic_years',
        'curriculum_generations',
        'study_programs',
        'course_equivalency_members',
      ].map((collection) => {
        const view = defaultViewOf(collection)?.layout_query.tabular;
        return [collection, view?.fields, view?.sort];
      }),
    ).toEqual([
      ['academic_years', ['label', 'published'], ['-label']],
      [
        'curriculum_generations',
        ['code', 'label', 'has_curriculum', 'published'],
        ['-code'],
      ],
      [
        'study_programs',
        ['generation', 'code', 'name', 'published'],
        ['generation', 'code'],
      ],
      [
        'course_equivalency_members',
        ['equivalency', 'generation', 'label', 'entry'],
        ['equivalency', 'generation'],
      ],
    ]);
  });
});
