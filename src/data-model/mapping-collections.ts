import type { CompositeKey } from '../schema-relations.js';
import type { ModelCollection } from '../schema.js';

import {
  countedLineSources,
  defaultYearPattern,
} from '../../directus/extensions/directus-extension-data-operations/src/enrollment-lines.js';
import { courseTemplate } from './content-collections.js';
import { academicYearTemplate } from './curriculum-collections.js';
import { enumField, labelledChoices, m2o, scalar } from './fields.js';

// How Moodle history lines count for a course: pattern mappings, tested
// against each line; the lines a count run counted per course and year
// (derived) and the matches it stages per page (candidates). The keys are
// below; the schema-constraints migration (ext/migrations.ts) holds them
// with the CHECKs and the write guards, and the pattern guard hook refuses
// a pattern or year pattern that does not compile.

const patternMappings = {
  plural: 'Pattern mappings',
  singular: 'Pattern mapping',
} as const;

const countedLines = {
  plural: 'Counted lines',
  singular: 'Counted line',
} as const;

const historyLineTemplate = '{{label}}';
const patternMappingTemplate = '{{course.name}}: {{pattern}}';
const lineInYearTemplate = '{{entry.label}} ({{academic_year.label}})';

const sourceChoices = labelledChoices(countedLineSources, {
  explicit: 'Explicit mapping',
  pattern: 'Pattern mapping',
});

export const mappingCollections: readonly ModelCollection[] = [
  {
    collection: 'moodle_pattern_mappings',
    displayTemplate: patternMappingTemplate,
    fields: [
      m2o('course', 'courses', {
        alias: {
          field: 'pattern_mappings',
          fields: ['pattern', 'year_pattern', 'only_in_year'],
          label: patternMappings.plural,
          note: 'A new course gets <name>- with the default year pattern. A renamed course keeps its mappings; a new Moodle name needs its own pattern.',
          template: '{{pattern}}',
        },
        label: 'Course',
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
        note: 'Group start or end captures the year the academic year starts or ends, in 2 or 4 digits (2 digits mean 20xx). A line without such a year is not counted.',
      }),
      // Deleting the academic year deletes its only-in-year mappings: a
      // mapping without a year and without a year pattern is refused.
      m2o('only_in_year', 'academic_years', {
        alias: {
          field: 'pattern_mappings',
          fields: ['course', 'pattern'],
          label: patternMappings.plural,
          template: patternMappingTemplate,
        },
        label: 'Only in year',
        note: "Counts the pattern only in this year, in place of the course's all-years mappings there.",
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
  // One row per history line and the course and year it counts for, with
  // the explicit or pattern mapping that counts it.
  {
    collection: 'moodle_counted_lines',
    displayTemplate:
      '{{entry.label}} - {{course.name}} ({{academic_year.label}})',
    fields: [
      m2o('entry', 'moodle_course_entries', {
        alias: {
          field: 'counted_for',
          fields: ['course', 'academic_year', 'source'],
          label: 'Counted for',
          readOnly: true,
          template: '{{course.name}} ({{academic_year.label}})',
        },
        label: 'History line',
        nullable: false,
        readOnly: true,
        template: historyLineTemplate,
      }),
      m2o('course', 'courses', {
        alias: {
          field: 'counted_lines',
          fields: ['entry', 'academic_year', 'source'],
          label: countedLines.plural,
          readOnly: true,
          template: lineInYearTemplate,
        },
        label: 'Course',
        nullable: false,
        readOnly: true,
        template: courseTemplate,
      }),
      m2o('academic_year', 'academic_years', {
        label: 'Academic year',
        nullable: false,
        readOnly: true,
        template: academicYearTemplate,
      }),
      enumField('source', sourceChoices, {
        label: 'Counted by',
        nullable: false,
        readOnly: true,
      }),
      // Empty for an explicit mapping. Deleting the pattern mapping deletes
      // the lines it counted, as the next count would.
      m2o('pattern_mapping', 'moodle_pattern_mappings', {
        alias: {
          field: 'counted_lines',
          fields: ['entry', 'academic_year'],
          label: 'Lines it counts',
          readOnly: true,
          template: lineInYearTemplate,
        },
        label: patternMappings.singular,
        onDelete: 'CASCADE',
        readOnly: true,
        template: patternMappingTemplate,
      }),
    ],
    hidden: true,
    icon: 'fact_check',
    label: countedLines,
    singleton: false,
    sort: 30,
  },
  // A history line one pattern mapping matches, staged under a claim per
  // page; the year is the one an all-years mapping reads from the line.
  {
    collection: 'data_operation_matches',
    displayTemplate: '{{claim_token}} / {{page_token}}',
    fields: [
      scalar('claim_token', 'string', {
        indexed: true,
        label: 'Claim token',
        nullable: false,
        readOnly: true,
      }),
      scalar('page_token', 'string', {
        label: 'Page token',
        nullable: false,
        readOnly: true,
      }),
      m2o('entry', 'moodle_course_entries', {
        label: 'History line',
        nullable: false,
        readOnly: true,
        template: historyLineTemplate,
      }),
      m2o('pattern_mapping', 'moodle_pattern_mappings', {
        label: patternMappings.singular,
        nullable: false,
        readOnly: true,
        template: patternMappingTemplate,
      }),
      // <start>/<start+1>; empty for an only-in-year mapping.
      scalar('year_label', 'string', { label: 'Year', readOnly: true }),
    ],
    hidden: true,
    icon: 'pending_actions',
    label: { plural: 'Match candidates', singular: 'Match candidate' },
    singleton: false,
    sort: 31,
  },
];

// The keys of these collections; relations.ts lists them with the others.
export const mappingKeys: readonly CompositeKey[] = [
  // One mapping per course, pattern, year pattern and year; an all-years
  // mapping has no year, an only-in-year one no year pattern.
  {
    collection: 'moodle_pattern_mappings',
    columns: ['course', 'pattern', 'year_pattern', 'only_in_year'],
    kind: 'unique',
    name: 'moodle_pattern_mappings_course_pattern_unique',
    nullsNotDistinct: true,
  },
  {
    collection: 'moodle_pattern_mappings',
    columns: ['course', 'only_in_year'],
    kind: 'index',
    name: 'moodle_pattern_mappings_course_only_in_year_index',
  },
  // One row per line, course, year and pattern mapping; a line an explicit
  // mapping counts has no pattern mapping.
  {
    collection: 'moodle_counted_lines',
    columns: ['entry', 'course', 'academic_year', 'pattern_mapping'],
    kind: 'unique',
    name: 'moodle_counted_lines_entry_course_year_mapping_unique',
    nullsNotDistinct: true,
  },
  {
    collection: 'data_operation_matches',
    columns: ['claim_token', 'page_token', 'entry', 'pattern_mapping'],
    kind: 'unique',
    name: 'data_operation_matches_claim_page_entry_mapping_unique',
  },
];
