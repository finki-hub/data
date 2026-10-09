import type { ModelCollection } from '../schema.js';

import { defaultYearPattern } from '../../directus/extensions/directus-extension-data-operations/src/enrollment-lines.js';
import { courseTemplate } from './content-collections.js';
import { academicYearTemplate } from './curriculum-collections.js';
import { m2o, scalar } from './fields.js';

// How Moodle history lines count for a course: pattern mappings, tested
// against each line. The database keys and CHECKs are in the
// schema-constraints migration (ext/migrations.ts); the pattern guard hook
// refuses a pattern or year pattern that does not compile.

const patternMappings = {
  plural: 'Pattern mappings',
  singular: 'Pattern mapping',
} as const;

export const mappingCollections: readonly ModelCollection[] = [
  {
    collection: 'moodle_pattern_mappings',
    displayTemplate: '{{course.name}}: {{pattern}}',
    fields: [
      m2o('course', 'courses', {
        alias: {
          field: 'pattern_mappings',
          fields: ['pattern', 'year_pattern', 'only_in_year'],
          label: patternMappings.plural,
          note: 'A new course gets <name>- with the default year pattern. Renaming the course keeps its mappings; add the new name as an alternative when Moodle uses it.',
          template: '{{pattern}}',
        },
        nullable: false,
        template: courseTemplate,
      }),
      scalar('pattern', 'text', {
        label: 'Pattern',
        note: 'Regular expression tested against each history line; ^ matches the start of the line.',
        nullable: false,
      }),
      // The default only prefills a new row: the pattern guard sends null
      // for a row created with a year, and the CHECK of the
      // schema-constraints migration requires exactly one of the two.
      scalar('year_pattern', 'text', {
        defaultValue: defaultYearPattern,
        label: 'Year pattern',
        note: 'Regular expression run on the whole line. Group start or end captures the year the academic year starts or ends, in 2 or 4 digits; 2 digits mean 20xx. The line counts in start/start+1. A line where it finds no such year is not counted.',
      }),
      // Deleting the academic year deletes its only-in-year mappings: a
      // mapping without a year and without a year pattern is refused.
      m2o('only_in_year', 'academic_years', {
        alias: {
          field: 'pattern_mappings',
          fields: ['course', 'pattern'],
          label: patternMappings.plural,
          template: '{{course.name}}: {{pattern}}',
        },
        label: 'Only in year',
        note: "Set: the pattern counts its lines only in this year and replaces this course's all-years mappings in that year. Year pattern is then cleared.",
        onDelete: 'CASCADE',
        template: academicYearTemplate,
      }),
    ],
    hidden: false,
    icon: 'regular_expression',
    label: patternMappings,
    singleton: false,
    sort: 25,
  },
];
