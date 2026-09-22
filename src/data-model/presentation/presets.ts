import { z } from 'zod';

import curriculumEntries from '../../../directus/presets/curriculum-entries.json' with { type: 'json' };
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

// The shared "Curriculum 2018" and "Curriculum 2023" bookmarks.
export const curriculumBookmarks: readonly PresetDefinition[] = z
  .array(presetSchema)
  .min(1)
  .parse(curriculumEntries);

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

// Default table views for the relational collections and for the checkpoint
// collections that gained relations. A populated deployment keeps the views
// its importer created; these only fill the gaps.
export const presetDefinitions: readonly PresetDefinition[] = [
  ...curriculumBookmarks,
  defaultView(
    'courses',
    [
      'name',
      'tags',
      'available_2023',
      'available_2018',
      'curricula',
      'assignments',
    ],
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
  defaultView('academic_years', ['label', 'sort'], ['sort']),
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
  defaultView(
    'course_equivalencies',
    ['course_2023', 'course_2018', 'course_2013', 'course'],
    ['course_2023'],
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
