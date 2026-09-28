import type { CollectionPlacement, Folder } from './types.js';

// Sidebar folders in display order. Helper, staging and candidate
// collections keep the `hidden` flag the model declares and stay reachable
// through the relation interfaces and their own URLs.
export const folders: readonly Folder[] = [
  {
    collapse: 'open',
    collection: 'courses_and_curriculum',
    icon: 'school',
    label: 'Courses & curriculum',
    members: [
      'courses',
      'curriculum_entries',
      'course_curricula',
      'curriculum_entry_program_states',
      'curriculum_generations',
      'study_programs',
      'course_equivalencies',
      'course_equivalency_members',
      'academic_years',
      'discord_channels',
    ],
    note: 'Courses, the curriculum entries they link to, the curriculum generations and study programs, and the course equivalencies.',
    sort: 1,
  },
  {
    collapse: 'closed',
    collection: 'staff_and_rooms',
    icon: 'groups',
    label: 'Staff & rooms',
    members: ['staff', 'teaching_assignments', 'rooms', 'deans_office'],
    note: 'Staff directory, teaching assignments, rooms and the dean’s office history.',
    sort: 2,
  },
  {
    collapse: 'closed',
    collection: 'student_records',
    icon: 'badge',
    label: 'Students',
    members: ['students', 'student_council'],
    note: 'Private student directory and council history.',
    sort: 3,
  },
  {
    collapse: 'closed',
    collection: 'moodle',
    icon: 'history_edu',
    label: 'Moodle',
    members: [
      'moodle_users',
      'moodle_course_entries',
      'moodle_course_mappings',
      'moodle_history_memberships',
      'moodle_import_rows',
    ],
    note: 'Moodle profile snapshot, course history entries and their mappings.',
    sort: 4,
  },
  {
    collapse: 'closed',
    collection: 'operations',
    icon: 'settings_suggest',
    label: 'Operations',
    members: [
      'course_enrollment_rules',
      'course_enrollments',
      'data_operations',
      'data_operation_results',
    ],
    note: 'Enrollment rules, derived counts and the private operation state.',
    sort: 5,
  },
];

export const collectionPlacements: readonly CollectionPlacement[] =
  folders.flatMap((folder) =>
    folder.members.map((collection, index) => ({
      collection,
      meta: { group: folder.collection, sort: index + 1 },
    })),
  );
