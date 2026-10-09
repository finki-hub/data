import type { WorkbookKey } from '../schema.js';
import type { SheetCell } from '../workbook-values.js';

// What the up-front check of the one-time import finds in the workbook,
// declared once. Every finding names the part of the workbook and the rows
// (ordinals of the rows read, 1 for the first) it concerns, never a value;
// stdout counts them per code, and stderr names each blocking case by its
// code, sheet, rows and course (src/import/refusal-text.ts).

// Cases that refuse the import before its first write: a relationship
// with more than one candidate (such as a teaching line several staff rows
// carry), a row the model cannot hold (such as a curriculum code that
// gives no level, or a teaching line no staff row carries), and a value
// the published files carry that no relational row could hold as the
// workbook states it. The operator corrects the workbook and imports
// again. What a rule can fix is no blocker: the import fixes it and warns
// (ruleFixCodes).
export const blockerCodes = [
  'ambiguous_course_name',
  'ambiguous_curriculum_2018',
  'ambiguous_curriculum_2023',
  'ambiguous_legacy_equivalency',
  'ambiguous_staff_name',
  'ambiguous_student_index',
  'curriculum_code_without_level',
  'duplicate_role_row',
  'inactive_course_assistants',
  'invalid_regex',
  'invalid_source_row',
  'missing_override_target',
  'unlinked_generation_values',
  'unmatched_curriculum_2018_label',
  'unmatched_curriculum_2023_label',
  'unmatched_staff_name',
] as const;

// Rows no published file ever used, left out of the import and counted: a
// teaching or pattern row naming no course, the teaching row of a course
// whose export row has typed professors (the export row wins), a pattern
// of a year the workbook does not list, and the earlier of several
// patterns of one course and year (the last one applies). A typed pattern
// that counts what the course's standard mapping counts in its year, or
// that a converted all-years mapping counts, is no mapping of its own.
export const skippedCodes = [
  'duplicate_pattern',
  'merged_pattern',
  'orphan_assignment',
  'orphan_pattern',
  'redundant_pattern',
  'superseded_assignment',
  'unknown_academic_year',
] as const;

// Rows imported as they are that deserve a look in Studio, and the rule
// fixes.
export const warningCodes = [
  'ambiguous_equivalency_entry',
  'duplicate_assignment',
  'duplicate_course_name',
  'duplicate_equivalency',
  'duplicate_staff_name',
  'duplicate_student_index',
  'equivalency_label_after_precedent',
  'formula_pattern_cell',
  'label_metacharacters',
  'newest_year_widened',
  'orphan_equivalency',
  'pattern_line_break',
  'repeated_staff_name',
  'unlinked_availability',
  'unmatched_council_index',
  'unmatched_equivalency_entry',
  'unreferenced_rows',
] as const;

// The warnings of what the import fixes by rule, never in the workbook:
// a later teaching row of a course is ignored (the first is used), an
// availability of TRUE without a name links nothing, a formula pattern
// cell is not read, a name listed again in one teaching cell is linked
// once, a typed pattern loses its line breaks, and the converted mappings
// count more in the newest year of a course without a typed cell there.
// The summary places each case (fixes).
export const ruleFixCodes = [
  'duplicate_assignment',
  'formula_pattern_cell',
  'newest_year_widened',
  'pattern_line_break',
  'repeated_staff_name',
  'unlinked_availability',
] as const satisfies ReadonlyArray<(typeof warningCodes)[number]>;

export type RuleFixCode = (typeof ruleFixCodes)[number];

export type FindingCode =
  | (typeof blockerCodes)[number]
  | (typeof skippedCodes)[number]
  | (typeof warningCodes)[number];

export type BlockerCode = (typeof blockerCodes)[number];

// Rows of one workbook part, by ordinal.
export type PartRows = {
  readonly collection: WorkbookKey;
  readonly ids: readonly number[];
};

// What else a case involves, never a value: the rows of other parts it
// concerns (such as the curriculum rows a name matches), the academic
// year of a pattern cell case (its column), the curriculum generation of
// a case about one generation's values, the place of a cell no row was
// read from (sheet, row and column header of a formula pattern cell,
// whose ids are empty), and the field of the row's cell a teaching case
// concerns with its lines (1 for the first; none when the case is the
// whole cell).
type CaseDetail = {
  readonly academicYear?: string;
  readonly cell?: SheetCell;
  readonly field?: string;
  readonly generation?: '2018' | '2023';
  readonly lines?: readonly number[];
  readonly related?: readonly PartRows[];
};

export type Finding = CaseDetail &
  PartRows & {
    readonly code: FindingCode;
  };

export const finding = (
  code: FindingCode,
  collection: WorkbookKey,
  ids: readonly number[],
): Finding => ({ code, collection, ids: [...ids] });

// A finding with what else its case involves.
export const detailed = (base: Finding, detail: CaseDetail): Finding => ({
  ...base,
  ...detail,
});

// The rows of a part a case involves besides its own.
export const relatedIds = (
  { related }: Finding,
  collection: WorkbookKey,
): readonly number[] =>
  (related ?? []).flatMap((rows) =>
    rows.collection === collection ? rows.ids : [],
  );

const collator = new Intl.Collator('en');

const compareIds = (left: readonly number[], right: readonly number[]) =>
  (left[0] ?? 0) - (right[0] ?? 0);

// Findings ordered by code, workbook part and first row, so every summary
// is stable.
export const sortFindings = (findings: readonly Finding[]): Finding[] =>
  findings.toSorted(
    (left, right) =>
      collator.compare(left.code, right.code) ||
      collator.compare(left.collection, right.collection) ||
      compareIds(left.ids, right.ids),
  );

const inList =
  (codes: readonly string[]) =>
  ({ code }: Finding): boolean =>
    codes.includes(code);

export const isBlocker = inList(blockerCodes);
export const isSkipped = inList(skippedCodes);
export const isWarning = inList(warningCodes);

const blockerSet: ReadonlySet<string> = new Set(blockerCodes);

export const isBlockerCode = (code: FindingCode): code is BlockerCode =>
  blockerSet.has(code);

const ruleFixSet: ReadonlySet<string> = new Set(ruleFixCodes);

export const isRuleFixCode = (code: FindingCode): code is RuleFixCode =>
  ruleFixSet.has(code);

// How often each key occurs, sorted by key.
export const countKeys = (
  keys: readonly string[],
): Readonly<Record<string, number>> => {
  const counts = new Map<string, number>();
  for (const key of keys) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(
    counts
      .entries()
      .toArray()
      .toSorted(([left], [right]) => collator.compare(left, right)),
  );
};

// Finding counts per code, sorted by code: the only view of findings a
// command prints on stdout.
export const countByCode = (
  findings: readonly Finding[],
): Readonly<Record<string, number>> =>
  countKeys(findings.map(({ code }) => code));
