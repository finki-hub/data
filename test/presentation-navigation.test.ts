import { describe, expect, test } from 'vitest';

import {
  dataModelCollectionKeys,
  dataModelCollections,
} from '../src/data-model/collections.js';
import {
  collectionPlacements,
  folders,
} from '../src/data-model/presentation/navigation.js';
import { findCollection } from './data-model-test-helpers.js';

// The sidebar: six folders by task, all closed, and Moodle users at the
// root. The folder bodies setup sends are checked in presentation.test.ts.

const collator = new Intl.Collator('en');

const sorted = (values: readonly string[]): readonly string[] =>
  values.toSorted((a, b) => collator.compare(a, b));

const helperCollections = [
  'course_curricula',
  'curriculum_entry_program_states',
  'discord_channel_courses',
  'data_operation_matches',
  'data_operations',
  'moodle_counted_lines',
  'moodle_history_memberships',
  'moodle_import_rows',
];

const hiddenCollections = (): readonly string[] =>
  dataModelCollections
    .filter((collection) => collection.hidden)
    .map(({ collection }) => collection);

describe('navigation', () => {
  test('places every model collection but Moodle users in exactly one folder', () => {
    const placed = collectionPlacements.map(({ collection }) => collection);

    expect(sorted(placed)).toEqual(
      sorted(
        dataModelCollections
          .map(({ collection }) => collection)
          .filter((collection) => collection !== 'moodle_users'),
      ),
    );
    expect(new Set(placed).size).toBe(placed.length);

    const folderNames = folders.map(({ collection }) => collection);

    expect(new Set(folderNames).size).toBe(folderNames.length);
    expect(
      collectionPlacements.filter(
        ({ meta }) =>
          !folderNames.includes(meta.group) || placed.includes(meta.group),
      ),
    ).toEqual([]);
  });

  test('groups the sidebar by task, with Moodle users at the root between Enrollments and Internals', () => {
    const moodleUsers = findCollection('moodle_users');
    const root = [
      ...folders.map(({ label, sort }) => ({ label, sort })),
      { label: moodleUsers.label?.plural, sort: moodleUsers.sort },
    ].toSorted((a, b) => a.sort - b.sort);

    expect(root).toEqual([
      { label: 'Courses', sort: 1 },
      { label: 'Curriculum', sort: 2 },
      { label: 'Staff & rooms', sort: 3 },
      { label: 'Students', sort: 4 },
      { label: 'Enrollments', sort: 5 },
      { label: 'Moodle users', sort: 6 },
      { label: 'Internals', sort: 7 },
    ]);
    expect(
      Object.fromEntries(
        folders.map(({ collection, members }) => [collection, members]),
      ),
    ).toEqual({
      folder_courses: ['courses', 'teaching_assignments', 'discord_channels'],
      folder_curriculum: [
        'curriculum_entries',
        'course_equivalencies',
        'course_equivalency_members',
        'curriculum_generations',
        'study_programs',
      ],
      folder_enrollments: [
        'academic_years',
        'moodle_course_entries',
        'moodle_pattern_mappings',
        'moodle_course_mappings',
      ],
      folder_internals: [
        'course_enrollments',
        'course_curricula',
        'curriculum_entry_program_states',
        'discord_channel_courses',
        'moodle_counted_lines',
        'moodle_history_memberships',
        'moodle_import_rows',
        'data_operation_matches',
        'data_operations',
      ],
      folder_staff_rooms: ['staff', 'rooms', 'deans_office'],
      folder_students: ['students', 'student_council'],
    });
  });

  test('starts every folder closed', () => {
    expect(
      folders
        .filter(({ collapse }) => collapse !== 'closed')
        .map(({ collection }) => collection),
    ).toEqual([]);
  });

  test('gives each folder a key that names no collection', () => {
    const collections = new Set<string>(dataModelCollectionKeys);

    expect(
      folders
        .map(({ collection }) => collection)
        .filter(
          (folder) => collections.has(folder) || !folder.startsWith('folder_'),
        ),
    ).toEqual([]);
  });

  test('files the hidden collections and Enrollment counts, and only them, in Internals', () => {
    const hidden = hiddenCollections();
    const internals = folders.find(
      ({ collection }) => collection === 'folder_internals',
    );

    expect(sorted(internals?.members ?? [])).toEqual(
      sorted([...hidden, 'course_enrollments']),
    );
    expect(internals?.members[0]).toBe('course_enrollments');
    expect(
      collectionPlacements
        .filter(({ collection }) => hidden.includes(collection))
        .filter(({ meta }) => meta.group !== 'folder_internals'),
    ).toEqual([]);
  });

  test('keeps junction, staging and candidate collections out of the sidebar', () => {
    expect(sorted(hiddenCollections())).toEqual(sorted(helperCollections));
  });
});
