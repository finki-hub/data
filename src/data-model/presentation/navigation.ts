import type { CollectionPlacement, Folder } from './types.js';

// Sidebar folders by task, in display order, all closed when Studio opens.
// A folder key carries the `folder_` prefix, so it never names a
// collection. Moodle users is in no folder: its model sort (6) places it
// between Enrollments and Internals. Helper, staging and candidate
// collections keep the `hidden` flag the model declares, sit in Internals
// and stay reachable through the relation interfaces and their own URLs.
export const folders: readonly Folder[] = [
  {
    collapse: 'closed',
    collection: 'folder_courses',
    icon: 'school',
    label: 'Courses',
    members: ['courses', 'teaching_assignments', 'discord_channels'],
    sort: 1,
  },
  {
    collapse: 'closed',
    collection: 'folder_curriculum',
    icon: 'menu_book',
    label: 'Curriculum',
    members: [
      'curriculum_entries',
      'course_equivalencies',
      'course_equivalency_members',
      'curriculum_generations',
      'study_programs',
    ],
    sort: 2,
  },
  {
    collapse: 'closed',
    collection: 'folder_staff_rooms',
    icon: 'groups',
    label: 'Staff & rooms',
    members: ['staff', 'rooms', 'deans_office'],
    sort: 3,
  },
  {
    collapse: 'closed',
    collection: 'folder_students',
    icon: 'badge',
    label: 'Students',
    members: ['students', 'student_council'],
    sort: 4,
  },
  {
    collapse: 'closed',
    collection: 'folder_enrollments',
    icon: 'history_edu',
    label: 'Enrollments',
    members: [
      'academic_years',
      'moodle_course_entries',
      'moodle_pattern_mappings',
      'moodle_course_mappings',
    ],
    sort: 5,
  },
  {
    collapse: 'closed',
    collection: 'folder_internals',
    icon: 'settings_suggest',
    label: 'Internals',
    members: [
      'course_enrollments',
      'course_curricula',
      'curriculum_entry_program_states',
      'moodle_counted_lines',
      'moodle_history_memberships',
      'moodle_import_rows',
      'data_operation_matches',
      'data_operations',
    ],
    sort: 7,
  },
];

export const collectionPlacements: readonly CollectionPlacement[] =
  folders.flatMap((folder) =>
    folder.members.map((collection, index) => ({
      collection,
      meta: { group: folder.collection, sort: index + 1 },
    })),
  );
