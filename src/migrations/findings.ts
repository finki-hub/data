import { blockerCodes, type Finding, type FindingCode } from './report.js';

const collator = new Intl.Collator('en');

const compareIds = (left: readonly number[], right: readonly number[]) =>
  (left[0] ?? 0) - (right[0] ?? 0);

// Findings ordered by code, collection and first id so a report is stable.
export const sortFindings = (findings: readonly Finding[]): Finding[] =>
  findings.toSorted(
    (left, right) =>
      collator.compare(left.code, right.code) ||
      collator.compare(left.collection, right.collection) ||
      compareIds(left.ids, right.ids) ||
      collator.compare(left.label ?? '', right.label ?? ''),
  );

export const isBlocker = (code: FindingCode): boolean =>
  (blockerCodes as readonly string[]).includes(code);
