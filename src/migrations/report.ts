import { z } from 'zod';

import { assignmentRoles } from '../data-model/checkpoint-collections.js';
import { collectionKeys } from '../schema.js';
import { columnsSchema } from './inventory-fields.js';
import { sourceMapEntrySchema } from './source-map.js';

export const migrationVersion = 'relational-1';

// Findings that block the cutover: an active relationship with more than
// one candidate identity, a rule the derivation cannot compile, an override
// pointing nowhere, or role rows recorded twice.
export const blockerCodes = [
  'ambiguous_course_name',
  'ambiguous_curriculum_2018',
  'ambiguous_curriculum_2023',
  'ambiguous_legacy_equivalency',
  'ambiguous_student_index',
  'duplicate_role_row',
  'invalid_regex',
  'invalid_source_row',
  'missing_override_target',
] as const;

// Findings that need review but preserve the rows as they are.
export const warningCodes = [
  'ambiguous_discord_course',
  'ambiguous_equivalency_entry',
  'ambiguous_staff_label',
  'duplicate_assignment',
  'duplicate_course_name',
  'duplicate_equivalency',
  'duplicate_pattern',
  'duplicate_staff_name',
  'duplicate_student_index',
  'equivalency_label_after_precedent',
  'label_metacharacters',
  'legacy_flow_present',
  'manual_link_retained',
  'model_not_installed',
  'orphan_assignment',
  'orphan_discord_course',
  'orphan_equivalency',
  'orphan_pattern',
  'persisted_flow',
  'unknown_academic_year',
  'unknown_source_field',
  'unlinked_generation_values',
  'unmatched_council_index',
  'unmatched_curriculum_2018_label',
  'unmatched_curriculum_2023_label',
  'unmatched_equivalency_entry',
  'unprovenanced_target_rows',
  'unreferenced_rows',
  'unresolved_staff_text',
] as const;

export const findingCodes = [...blockerCodes, ...warningCodes] as const;

export type FindingCode = (typeof findingCodes)[number];

const id = z.number().int();
const ids = z.array(id).readonly();
const hex64 = z.string().regex(/^[0-9a-f]{64}$/u);

export const resolutionSchema = z.enum([
  'ambiguous',
  'missing',
  'none',
  'unique',
]);

export type Resolution = z.infer<typeof resolutionSchema>;

export const findingSchema = z.object({
  code: z.enum(findingCodes),
  collection: z.string(),
  ids,
  label: z.string().nullable(),
  message: z.string(),
});

export type Finding = z.infer<typeof findingSchema>;

const linkSchema = z.object({
  label: z.string().nullable(),
  matches: ids,
  precedent: id.nullable(),
  resolution: resolutionSchema,
});

// The staff rows a professor or assistant text points at: linked only when
// `unique`; `ambiguous` carries the ids in contention and links none;
// `unresolved` retains the text as display text; `none` is an empty text.
const staffCandidateSchema = z.object({
  parts: z.array(z.string()).readonly(),
  resolution: z.enum(['ambiguous', 'none', 'unique', 'unresolved']),
  role: z.enum(assignmentRoles),
  staff: ids,
  text: z.string().nullable(),
});

export type StaffCandidate = z.infer<typeof staffCandidateSchema>;

// `chosen` is the pattern row whose override applies (the last ascending
// id); null when the rule is the `<name>-<year>` default.
const ruleCandidateSchema = z.object({
  academicYear: z.string(),
  chosen: id.nullable(),
  overrides: ids,
  pattern: z.string(),
  source: z.enum(['default', 'override']),
  valid: z.boolean(),
});

export type RuleCandidate = z.infer<typeof ruleCandidateSchema>;

const courseCandidateSchema = z.object({
  assignment: z.object({
    chosen: id.nullable(),
    matches: ids,
    rule: z.literal('first_id'),
  }),
  current: linkSchema,
  id,
  legacy: z.object({
    entry: linkSchema,
    equivalencies: linkSchema,
    label: z.string().nullable(),
    source: z.enum(['equivalency', 'none', 'override']),
  }),
  name: z.string(),
  professorsOverride: z.string().nullable(),
  rules: z.array(ruleCandidateSchema).readonly(),
  staff: z.array(staffCandidateSchema).readonly(),
});

export type CourseCandidate = z.infer<typeof courseCandidateSchema>;

const councilCandidateSchema = z.object({
  id,
  indexNumber: z.string().nullable(),
  student: linkSchema,
});

export type CouncilCandidate = z.infer<typeof councilCandidateSchema>;

const candidatesSchema = z.object({
  assignments: z
    .array(
      z.object({
        course: linkSchema,
        id,
        staff: z.array(staffCandidateSchema).readonly(),
      }),
    )
    .readonly(),
  council: z.array(councilCandidateSchema).readonly(),
  courses: z.array(courseCandidateSchema).readonly(),
  discord: z
    .array(
      z.object({
        channel: z.string().nullable(),
        courses: z.array(linkSchema).readonly(),
        id,
      }),
    )
    .readonly(),
  equivalencies: z
    .array(
      z.object({
        course: linkSchema,
        entry2018: linkSchema,
        entry2023: linkSchema,
        id,
      }),
    )
    .readonly(),
  patterns: z
    .array(
      z.object({
        academicYear: z.string().nullable(),
        course: linkSchema,
        id,
        knownYear: z.boolean(),
      }),
    )
    .readonly(),
});

export type Candidates = z.infer<typeof candidatesSchema>;

export const ledgerSummarySchema = z.object({
  completed: z.array(z.string()).readonly(),
  failed: z.array(z.string()).readonly(),
  running: z.array(z.string()).readonly(),
});

export type LedgerSummary = z.infer<typeof ledgerSummarySchema>;

export const migrationReportSchema = z.object({
  blockers: z.array(findingSchema).readonly(),
  candidates: candidatesSchema,
  counts: z.object({
    collections: z.record(z.enum(collectionKeys), z.number().int()),
    flows: z.number().int(),
    operations: z.number().int(),
  }),
  fields: columnsSchema,
  flows: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        operationTypes: z.array(z.string()).readonly(),
        status: z.string(),
        trigger: z.string().nullable(),
      }),
    )
    .readonly(),
  ledger: ledgerSummarySchema.nullable(),
  mappings: z.array(sourceMapEntrySchema).readonly(),
  migratable: z.boolean(),
  sourceFingerprint: hex64,
  targets: z
    .object({
      academic_years: z.number().int(),
      course_curricula: z.number().int(),
      course_enrollment_rules: z.number().int(),
      curriculum_entries: z.number().int(),
    })
    .nullable(),
  version: z.literal(migrationVersion),
  warnings: z.array(findingSchema).readonly(),
});

export type MigrationReport = z.infer<typeof migrationReportSchema>;
