import { z } from 'zod';

import type { ReadinessEntry } from '../../../directus/extensions/directus-extension-data-operations/src/exports/readiness-types.js';

import { readinessRegistry } from '../../../directus/extensions/directus-extension-data-operations/src/exports/readiness-registry.js';
import { findModelCollection } from '../collections.js';

const tabularQuerySchema = z.object({
  fields: z.array(z.string()).min(1),
  limit: z.number().int().positive(),
  page: z.number().int().positive(),
  sort: z.array(z.string()).min(1),
});

// The `POST /presets` body: `bookmark` names a shared bookmark, null makes
// the preset the collection default; `filter` is one filter object.
export const presetSchema = z.object({
  bookmark: z.string().nullable(),
  collection: z.string(),
  filter: z.record(z.string(), z.unknown()).nullable(),
  icon: z.string(),
  layout: z.literal('tabular'),
  layout_options: z.object({
    tabular: z.object({ spacing: z.enum(['comfortable', 'compact', 'cozy']) }),
  }),
  layout_query: z.object({ tabular: tabularQuerySchema }),
  role: z.null(),
  search: z.null(),
  user: z.null(),
});

export type PresetDefinition = z.infer<typeof presetSchema>;

const defaultView = (
  collection: string,
  fields: readonly string[],
  sort: readonly string[],
): PresetDefinition => ({
  bookmark: null,
  collection,
  filter: null,
  icon: findModelCollection(collection)?.icon ?? 'table_view',
  layout: 'tabular',
  layout_options: { tabular: { spacing: 'comfortable' } },
  layout_query: {
    tabular: { fields: [...fields], limit: 25, page: 1, sort: [...sort] },
  },
  role: null,
  search: null,
  user: null,
});

// The one shared curriculum bookmark: every entry, generation first,
// sorted by generation and catalog order. Editors narrow it to one
// generation with Studio's native filter on `generation`, so a new
// generation row needs no bookmark and no setup rerun.
export const curriculumBookmark: PresetDefinition = presetSchema.parse({
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
): readonly PresetDefinition[] =>
  registry.flatMap(({ page, review }) =>
    review === undefined
      ? []
      : [
          presetSchema.parse({
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

// Default table views for the relational collections and for the checkpoint
// collections that gained relations.
const defaultViews: readonly PresetDefinition[] = [
  // The curriculum links replace the imported per-generation columns.
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
  // The copied `name` stays listed beside the linked student until every
  // council row carries a student link.
  defaultView(
    'student_council',
    ['year', 'student.name', 'name', 'index_number', 'position'],
    ['-year'],
  ),
  defaultView('course_equivalencies', ['course', 'members'], ['course_2023']),
  defaultView(
    'course_equivalency_members',
    ['equivalency', 'generation', 'label', 'entry'],
    ['equivalency', 'sort'],
  ),
  defaultView(
    'moodle_import_rows',
    ['Name', 'Mail', 'ID_new', 'Courses Count'],
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
];

// Every shared preset the presentation declares for a readiness
// registry: the curriculum bookmark, its Needs review bookmarks and the
// default table views. A populated deployment keeps the views its
// importer created; these only fill the gaps.
export const presetDefinitionsFor = (
  registry: readonly ReadinessEntry[],
): readonly PresetDefinition[] => [
  curriculumBookmark,
  ...reviewPresets(registry),
  ...defaultViews,
];

// The presets of the declared readiness registry.
export const presetDefinitions: readonly PresetDefinition[] =
  presetDefinitionsFor(readinessRegistry);
