import { searchBookmark, unmappedLinesBookmark } from './bookmarks.js';
import {
  defaultView,
  type PresetDefinition,
  type TabularPreset,
} from './preset-schema.js';

// A default table view for every collection Studio lists.
const defaultViews: readonly TabularPreset[] = [
  // Each generation's entry, credits and availability are on the
  // curriculum links.
  defaultView(
    'courses',
    ['name', 'status', 'tags', 'curricula', 'assignments'],
    ['name'],
  ),
  // Generation first, in catalog order; Studio's native filter on
  // `generation` narrows it to one generation.
  defaultView(
    'curriculum_entries',
    ['generation', 'code', 'name', 'semester', 'channel', 'course_links'],
    ['generation', 'catalog_order'],
  ),
  defaultView(
    'course_curricula',
    ['course', 'generation', 'entry', 'credits', 'available'],
    ['course', 'generation'],
  ),
  // Newest first: a year's label and a generation's code sort as their
  // dates do.
  defaultView('academic_years', ['label', 'published'], ['-label']),
  defaultView(
    'curriculum_generations',
    ['code', 'label', 'has_curriculum', 'published'],
    ['-code'],
  ),
  defaultView(
    'study_programs',
    ['generation', 'code', 'name', 'published'],
    ['generation', 'code'],
  ),
  defaultView(
    'teaching_assignments',
    ['course', 'role', 'staff'],
    ['course', 'sort'],
  ),
  // The linked student names a member; the index is the only label of an
  // unlinked one.
  defaultView(
    'student_council',
    ['year', 'student.name', 'index_number', 'position'],
    ['-year'],
  ),
  defaultView('course_equivalencies', ['course', 'members'], ['id']),
  defaultView(
    'course_equivalency_members',
    ['equivalency', 'generation', 'label', 'entry'],
    ['equivalency', 'generation'],
  ),
  defaultView(
    'moodle_import_rows',
    ['Name', 'Mail', 'ID_old', 'ID_new', 'Courses Count'],
    ['Name'],
  ),
  defaultView('moodle_course_entries', ['label', 'first_seen'], ['label']),
  defaultView(
    'moodle_history_memberships',
    ['moodle_user', 'entry', 'sort'],
    ['moodle_user', 'sort'],
  ),
  defaultView(
    'moodle_pattern_mappings',
    ['course', 'pattern', 'year_pattern', 'only_in_year'],
    ['course'],
  ),
  defaultView(
    'moodle_course_mappings',
    ['entry', 'course', 'academic_year'],
    ['entry'],
  ),
  defaultView(
    'course_enrollments',
    ['course', 'academic_year', 'count', 'computed_at'],
    ['course'],
  ),
  defaultView(
    'staff',
    ['name', 'active', 'position', 'email', 'cabinet'],
    ['name'],
  ),
  defaultView(
    'rooms',
    ['name', 'type', 'location', 'floor', 'capacity'],
    ['location'],
  ),
  defaultView(
    'students',
    ['index_number', 'name', 'source_group'],
    ['-source_group'],
  ),
  defaultView(
    'discord_channels',
    ['semester', 'channel', 'courses'],
    ['semester', 'channel'],
  ),
  // Newest year first, its terms by position.
  defaultView(
    'deans_office',
    ['year', 'position', 'staff'],
    ['-year', 'position'],
  ),
  // The main Moodle users table.
  defaultView(
    'moodle_users',
    ['Name', 'Mail', 'ID_new', 'ID_old', 'Courses Count', 'Courses'],
    ['Name'],
  ),
];

// Every shared preset setup installs: the default table views, the Search
// bookmark and the Unmapped Moodle Courses bookmark, each once by
// collection and bookmark name, keeping an existing one. The
// incomplete-data bookmarks come from the import
// (src/import/incomplete-data-bookmarks.ts).
export const presetDefinitions: readonly PresetDefinition[] = [
  ...defaultViews,
  searchBookmark,
  unmappedLinesBookmark,
];
