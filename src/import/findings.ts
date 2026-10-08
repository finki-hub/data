import type { WorkbookKey } from '../schema.js';
import type { SheetCell } from '../workbook-values.js';

// What the up-front check of the one-time import finds in the workbook,
// declared once. Every finding names the part of the workbook and the rows
// (ordinals of the rows read, 1 for the first) it concerns, never a value;
// stdout counts them per code, and stderr names each blocking case by its
// code, sheet, rows and course (src/import/refusal-text.ts).

// Cases that refuse the import before its first write: a relationship
// with more than one candidate, a row the model cannot hold (such as a
// curriculum code that gives no level), and a value the published files
// carry that no relational row could hold as the workbook states it. The
// operator corrects the workbook and imports again. What a rule can fix is
// no blocker: the import fixes it and warns (ruleFixCodes).
export const blockerCodes = [
  'ambiguous_course_name',
  'ambiguous_curriculum_2018',
  'ambiguous_curriculum_2023',
  'ambiguous_legacy_equivalency',
  'ambiguous_student_index',
  'curriculum_code_without_level',
  'duplicate_role_row',
  'invalid_regex',
  'invalid_source_row',
  'missing_override_target',
  'unlinked_generation_values',
  'unmatched_curriculum_2018_label',
  'unmatched_curriculum_2023_label',
] as const;

// Rows no published file ever used, left out of the import and counted: a
// teaching or pattern row naming no course, a pattern of a year the
// workbook does not list, and the earlier of several patterns of one
// course and year (the last one applies).
export const skippedCodes = [
  'duplicate_pattern',
  'orphan_assignment',
  'orphan_pattern',
  'unknown_academic_year',
] as const;

// Rows imported as they are that deserve a look in Studio, and the rule
// fixes.
export const warningCodes = [
  'ambiguous_equivalency_entry',
  'ambiguous_staff_label',
  'duplicate_assignment',
  'duplicate_course_name',
  'duplicate_equivalency',
  'duplicate_staff_name',
  'duplicate_student_index',
  'equivalency_label_after_precedent',
  'formula_pattern_cell',
  'label_metacharacters',
  'orphan_equivalency',
  'unlinked_availability',
  'unmatched_council_index',
  'unmatched_equivalency_entry',
  'unreferenced_rows',
  'unresolved_staff_text',
] as const;

// The warnings of what the import fixes by rule, never in the workbook:
// a later teaching row of a course is ignored (the first is used), an
// availability of TRUE without a name links nothing, and a formula
// pattern cell is not read. The summary places each case (fixes).
export const ruleFixCodes = [
  'duplicate_assignment',
  'formula_pattern_cell',
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
// concerns (such as the curriculum rows a name matches), the curriculum
// generation of a case about one generation's values, and the place of a
// cell no row was read from (sheet, row and column header of a formula
// pattern cell, whose ids are empty).
type CaseDetail = {
  readonly cell?: SheetCell;
  readonly generation?: '2018' | '2023';
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
