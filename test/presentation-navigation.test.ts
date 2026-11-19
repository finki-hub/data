import { describe, expect, test } from 'vitest';

import {
  dataModelCollectionKeys,
  dataModelCollections,
} from '../src/data-model/collections.js';
import {
  collectionPlacements,
  folders,
} from '../src/data-model/presentation/navigation.js';

// The sidebar: eleven folders by subject, all closed, holding every
// collection. The folder bodies setup sends are checked in
// presentation.test.ts.

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
  test('places every model collection in exactly one folder', () => {
    const placed = collectionPlacements.map(({ collection }) => collection);

    expect(sorted(placed)).toEqual(
      sorted(dataModelCollections.map(({ collection }) => collection)),
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

  test('groups the sidebar by subject', () => {
    expect(folders.map(({ label, sort }) => ({ label, sort }))).toEqual([
      { label: 'Search', sort: 1 },
      { label: 'Courses', sort: 2 },
      { label: 'Teaching', sort: 3 },
      { label: 'Accreditations', sort: 4 },
      { label: 'Degree programs', sort: 5 },
      { label: 'People', sort: 6 },
      { label: 'Timetables & rooms', sort: 7 },
      { label: 'Enrollments', sort: 8 },
      { label: 'Theses', sort: 9 },
      { label: 'Discord bot', sort: 10 },
      { label: 'Internals', sort: 11 },
    ]);
    expect(
      Object.fromEntries(
        folders.map(({ collection, members }) => [collection, members]),
      ),
    ).toEqual({
      folder_accreditations: [
        'curriculum_generations',
        'study_programs',
        'curriculum_entries',
      ],
      folder_courses: [
        'courses',
        'course_equivalencies',
        'course_equivalency_members',
      ],
      folder_degree_programs: [
        'degree_programs',
        'degree_program_courses',
        'degree_program_slots',
      ],
      folder_discord_bot: ['discord_channels', 'anto_quotes'],
      folder_enrollments: [
        'academic_years',
        'course_enrollments',
        'moodle_course_entries',
        'moodle_pattern_mappings',
        'moodle_course_mappings',
        'moodle_left_uncounted',
      ],
      folder_internals: [
        'course_aliases',
        'staff_aliases',
        'room_aliases',
        'course_curricula',
        'curriculum_entry_program_states',
        'discord_channel_courses',
        'moodle_counted_lines',
        'moodle_history_memberships',
        'moodle_import_rows',
        'data_operation_matches',
        'data_operations',
      ],
      folder_search: ['moodle_users'],
      folder_people: ['staff', 'deans_office', 'student_council', 'students'],
      folder_teaching: [
        'course_teaching',
        'course_accreditation_staff',
        'teaching_assignments',
      ],
      folder_theses: [
        'bachelor_theses',
        'master_theses',
        'bachelor_thesis_staff',
        'master_thesis_staff',
      ],
      folder_timetables_rooms: [
        'timetables',
        'timetable_lessons',
        'timetable_slots',
        'timetable_slot_staff',
        'timetable_slot_courses',
        'rooms',
        'exam_sessions',
      ],
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

  test('files the name aliases and the hidden collections, and only them, in Internals', () => {
    const hidden = hiddenCollections();
    const internals = folders.find(
      ({ collection }) => collection === 'folder_internals',
    );

    expect(sorted(internals?.members ?? [])).toEqual(
      sorted([...hidden, 'course_aliases', 'staff_aliases', 'room_aliases']),
    );
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
