import type { ReadinessEntry } from '../../../directus/extensions/directus-extension-data-operations/src/exports/readiness-types.js';

import { readinessRegistry } from '../../../directus/extensions/directus-extension-data-operations/src/exports/readiness-registry.js';
import { findModelCollection } from '../collections.js';
import {
  curriculumBookmark,
  searchBookmark,
  unmappedLinesBookmark,
} from './bookmarks.js';
import {
  defaultView,
  type PresetDefinition,
  type TabularPreset,
  tabularPresetSchema,
} from './preset-schema.js';

// The shared Needs review bookmarks: one per readiness-registry entry
// that declares a review view, on its page collection (the collection
// whose records it counts), in registry order. A check that declares a
// view gets its bookmark from the create-missing planner on the next
// setup, and the dashboard links the check to it by the same page and
// name; nothing here names a check. A generation-scoped view is one
// bookmark that shows the generation, never one per generation row.
export const reviewPresets = (
  registry: readonly ReadinessEntry[] = readinessRegistry,
): readonly TabularPreset[] =>
  registry.flatMap(({ page, review }) =>
    review === undefined
      ? []
      : [
          tabularPresetSchema.parse({
            bookmark: review.bookmark,
            collection: page,
            filter: review.filter,
            icon: review.icon ?? findModelCollection(page)?.icon ?? 'rule',
            layout: 'tabular',
            layout_options: { tabular: { spacing: 'comfortable' } },
            layout_query: {
              tabular: {
                fields: [...review.fields],
                limit: 50,
                page: 1,
                sort: [...review.sort],
              },
            },
            role: null,
            search: null,
            user: null,
          }),
        ],
  );

// A default table view for every collection Studio lists.
const defaultViews: readonly TabularPreset[] = [
  // Each generation's entry, credits and availability are on the
  // curriculum links.
  defaultView(
    'courses',
    ['name', 'status', 'tags', 'curricula', 'assignments'],
    ['name'],
  ),
  defaultView(
    'curriculum_entries',
    ['generation', 'code', 'name', 'semester', 'channel'],
    ['generation', 'catalog_order'],
  ),
  defaultView(
    'course_curricula',
    ['course', 'generation', 'entry', 'credits', 'available'],
    ['course', 'generation'],
  ),
  // Newest first, as courses.json lists the published years and
  // generations.
  defaultView('academic_years', ['label', 'published', 'sort'], ['-sort']),
  defaultView(
    'curriculum_generations',
    ['code', 'label', 'has_curriculum', 'published', 'sort'],
    ['-sort'],
  ),
  defaultView(
    'study_programs',
    ['generation', 'code', 'name', 'published', 'sort'],
    ['generation', 'sort'],
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
    ['equivalency', 'sort'],
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
    ['semester', 'channel', 'course_names'],
    ['semester'],
  ),
  defaultView('deans_office', ['year', 'name', 'position'], ['-year']),
  // The main Moodle users table.
  defaultView(
    'moodle_users',
    ['Name', 'Mail', 'ID_new', 'ID_old', 'Courses Count', 'Courses'],
    ['Name'],
  ),
];

// Every shared preset the presentation declares for a readiness
// registry: the curriculum bookmark, its Needs review bookmarks, the
// default table views, the Search bookmark and the Unmapped history lines
// bookmark. Setup installs each once by collection and bookmark name and
// keeps an existing one.
export const presetDefinitionsFor = (
  registry: readonly ReadinessEntry[],
): readonly PresetDefinition[] => [
  curriculumBookmark,
  ...reviewPresets(registry),
  ...defaultViews,
  searchBookmark,
  unmappedLinesBookmark,
];

// The presets of the declared readiness registry.
export const presetDefinitions: readonly PresetDefinition[] =
  presetDefinitionsFor(readinessRegistry);
