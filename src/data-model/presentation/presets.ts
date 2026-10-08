import type { ReadinessEntry } from '../../../directus/extensions/directus-extension-data-operations/src/exports/readiness-types.js';

import { readinessRegistry } from '../../../directus/extensions/directus-extension-data-operations/src/exports/readiness-registry.js';
import courseSearch from '../../../directus/presets/course-search.json' with { type: 'json' };
import { findModelCollection } from '../collections.js';
import {
  defaultView,
  type PresetDefinition,
  presetSchema,
  type TabularPreset,
  tabularPresetSchema,
} from './preset-schema.js';

// The one shared curriculum bookmark: every entry, generation first,
// sorted by generation and catalog order. Studio's native filter on
// `generation` narrows it to one generation, so a new generation row
// needs no bookmark and no setup rerun.
export const curriculumBookmark: TabularPreset = tabularPresetSchema.parse({
  bookmark: 'Curriculum by generation',
  collection: 'curriculum_entries',
  filter: null,
  icon: 'menu_book',
  layout: 'tabular',
  layout_options: { tabular: { spacing: 'comfortable' } },
  layout_query: {
    tabular: {
      fields: [
        'generation',
        'code',
        'name',
        'level',
        'semester',
        'channel',
        'course_links',
      ],
      limit: 50,
      page: 1,
      sort: ['generation', 'catalog_order'],
    },
  },
  role: null,
  search: null,
  user: null,
});

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

// The shared Search bookmark on the Moodle users, declared in
// directus/presets/course-search.json.
export const searchBookmark: PresetDefinition =
  presetSchema.parse(courseSearch);

// A default table view for every collection Studio lists.
const defaultViews: readonly TabularPreset[] = [
  // Each generation's entry, credits and availability are on the
  // curriculum links.
  defaultView(
    'courses',
    ['name', 'tags', 'curricula', 'assignments'],
    ['name'],
  ),
  defaultView(
    'curriculum_entries',
    ['generation', 'code', 'name', 'level', 'semester', 'channel'],
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
    ['course', 'role', 'staff', 'display_override'],
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
  defaultView(
    'moodle_course_entries',
    ['label', 'review_state', 'review_reason'],
    ['label'],
  ),
  defaultView(
    'moodle_history_memberships',
    ['moodle_user', 'entry', 'sort'],
    ['moodle_user', 'sort'],
  ),
  defaultView(
    'moodle_course_mappings',
    ['entry', 'course', 'academic_year'],
    ['entry'],
  ),
  defaultView(
    'course_enrollment_rules',
    ['course', 'academic_year', 'mode', 'pattern'],
    ['course'],
  ),
  defaultView(
    'course_enrollments',
    ['course', 'academic_year', 'count', 'computed_at'],
    ['course'],
  ),
  defaultView(
    'data_operation_results',
    ['claim_token', 'page_token', 'course', 'academic_year', 'count'],
    ['claim_token'],
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
// default table views and the Search bookmark. Setup installs each once
// by collection and bookmark name and keeps an existing one.
export const presetDefinitionsFor = (
  registry: readonly ReadinessEntry[],
): readonly PresetDefinition[] => [
  curriculumBookmark,
  ...reviewPresets(registry),
  ...defaultViews,
  searchBookmark,
];

// The presets of the declared readiness registry.
export const presetDefinitions: readonly PresetDefinition[] =
  presetDefinitionsFor(readinessRegistry);
