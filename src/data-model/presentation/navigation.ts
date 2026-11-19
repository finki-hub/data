import type { CollectionPlacement, Folder } from './types.js';

// Sidebar folders by subject, in display order, all closed when Studio
// opens. A folder key carries the `folder_` prefix, so it never names a
// collection. Every collection sits in a folder. Internals holds the
// matching and bookkeeping tables: the other spellings the imports match
// courses, staff and rooms by, then the helper, staging and candidate
// collections, which keep the `hidden` flag the model declares and stay
// reachable through the relation interfaces and their own URLs.
const sidebarFolder = ({
  icon,
  key,
  label,
  members,
}: {
  readonly icon: string;
  readonly key: string;
  readonly label: string;
  readonly members: readonly string[];
}): Omit<Folder, 'sort'> => ({
  collapse: 'closed',
  collection: `folder_${key}`,
  icon,
  label,
  members,
});

export const folders: readonly Folder[] = [
  // The Moodle users, whose Search bookmark finds students by the courses
  // they took (or did not).
  sidebarFolder({
    icon: 'person_search',
    key: 'search',
    label: 'Search',
    members: ['moodle_users'],
  }),
  sidebarFolder({
    icon: 'school',
    key: 'courses',
    label: 'Courses',
    members: ['courses', 'course_equivalencies', 'course_equivalency_members'],
  }),
  // Who teaches a course, from each source courses.json reads.
  sidebarFolder({
    icon: 'co_present',
    key: 'teaching',
    label: 'Teaching',
    members: [
      'course_teaching',
      'course_accreditation_staff',
      'teaching_assignments',
    ],
  }),
  // The undergraduate accreditations behind courses.json.
  sidebarFolder({
    icon: 'menu_book',
    key: 'accreditations',
    label: 'Accreditations',
    members: ['curriculum_generations', 'study_programs', 'curriculum_entries'],
  }),
  sidebarFolder({
    icon: 'account_tree',
    key: 'degree_programs',
    label: 'Degree programs',
    members: [
      'degree_programs',
      'degree_program_courses',
      'degree_program_slots',
    ],
  }),
  sidebarFolder({
    icon: 'groups',
    key: 'people',
    label: 'People',
    members: ['staff', 'deans_office', 'student_council', 'students'],
  }),
  sidebarFolder({
    icon: 'calendar_view_week',
    key: 'timetables_rooms',
    label: 'Timetables & rooms',
    members: [
      'timetables',
      'timetable_lessons',
      'timetable_slots',
      'timetable_slot_staff',
      'timetable_slot_courses',
      'rooms',
      'exam_sessions',
    ],
  }),
  sidebarFolder({
    icon: 'history_edu',
    key: 'enrollments',
    label: 'Enrollments',
    members: [
      'academic_years',
      'course_enrollments',
      'moodle_course_entries',
      'moodle_pattern_mappings',
      'moodle_course_mappings',
      'moodle_left_uncounted',
    ],
  }),
  sidebarFolder({
    icon: 'workspace_premium',
    key: 'theses',
    label: 'Theses',
    members: [
      'bachelor_theses',
      'master_theses',
      'bachelor_thesis_staff',
      'master_thesis_staff',
    ],
  }),
  sidebarFolder({
    icon: 'smart_toy',
    key: 'discord_bot',
    label: 'Discord bot',
    members: ['discord_channels', 'anto_quotes'],
  }),
  sidebarFolder({
    icon: 'settings_suggest',
    key: 'internals',
    label: 'Internals',
    members: [
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
  }),
].map((entry, index) => ({ ...entry, sort: index + 1 }));

export const collectionPlacements: readonly CollectionPlacement[] =
  folders.flatMap((folder) =>
    folder.members.map((collection, index) => ({
      collection,
      meta: { group: folder.collection, sort: index + 1 },
    })),
  );
