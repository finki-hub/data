import { coordinationError } from './coordination/errors.js';
import {
  historyPageBudget,
  legacyPatternBudget,
  legacyRulePageSize,
  pageSize,
} from './coordination/state.js';
import { type IdRange } from './page-state.js';

// The sizing of the pages a crossed rule family (rules_x_histories in
// rule-modes.ts) plans: history pages and rule pages, each cut by a row
// count and a byte budget.

export type EnrollmentLimits = {
  readonly budget: number;
  readonly patternBudget: number;
  readonly rulePageSize: number;
  readonly userPageSize: number;
};

// One Moodle user: its id and the UTF-8 bytes of its raw `Courses` text,
// never the text itself.
export type HistorySize = { readonly bytes: number; readonly id: number };

// Consecutive rows of at most a row count and a byte budget: a history
// page or a rule page of a crossed family.
export type SizedRange = IdRange & { readonly bytes: number };

export const enrollmentLimits: EnrollmentLimits = {
  budget: historyPageBudget,
  patternBudget: legacyPatternBudget,
  rulePageSize: legacyRulePageSize,
  userPageSize: pageSize,
};

// A row the planner sizes: a Moodle user or a rule, by id and bytes.
export type Sized = { readonly bytes: number; readonly id: number };

// Splits sized rows into consecutive ranges of at most `rows` rows and
// `budget` bytes. A row that alone exceeds the budget fits no range, so
// the plan is refused by `oversized`, which names the row and sizes only.
const sizedRanges = (
  items: readonly Sized[],
  limit: { readonly budget: number; readonly rows: number },
  oversized: (item: Sized) => Error,
): SizedRange[] => {
  const ranges: SizedRange[] = [];
  const sorted = items.toSorted((left, right) => left.id - right.id);
  for (const item of sorted) {
    if (item.bytes > limit.budget) {
      throw oversized(item);
    }
    const last = ranges.at(-1);
    if (
      last === undefined ||
      last.rows >= limit.rows ||
      last.bytes + item.bytes > limit.budget
    ) {
      ranges.push({ bytes: item.bytes, from: item.id, rows: 1, to: item.id });
    } else {
      ranges[ranges.length - 1] = {
        bytes: last.bytes + item.bytes,
        from: last.from,
        rows: last.rows + 1,
        to: item.id,
      };
    }
  }
  return ranges;
};

// Splits the users into consecutive pages of at most `userPageSize` rows
// and `budget` bytes of history.
export const historyRanges = (
  users: readonly HistorySize[],
  limits: EnrollmentLimits = enrollmentLimits,
): SizedRange[] =>
  sizedRanges(
    users,
    { budget: limits.budget, rows: limits.userPageSize },
    (user) =>
      coordinationError(
        'PAGE_OVER_BUDGET',
        `Moodle user ${String(user.id)}: Courses history ${String(user.bytes)} bytes, max ${String(limits.budget)} per page`,
        {
          details: { budget: limits.budget, bytes: user.bytes, user: user.id },
        },
      ),
  );

// Splits the rules of a crossed family into consecutive pages of at most
// `rulePageSize` rules and `patternBudget` bytes of pattern text.
export const legacyRuleRanges = (
  rules: readonly Sized[],
  limits: EnrollmentLimits = enrollmentLimits,
): SizedRange[] =>
  sizedRanges(
    rules,
    { budget: limits.patternBudget, rows: limits.rulePageSize },
    (rule) =>
      coordinationError(
        'PAGE_OVER_BUDGET',
        `Rule ${String(rule.id)}: pattern ${String(rule.bytes)} bytes, max ${String(limits.patternBudget)} per page`,
        {
          details: {
            budget: limits.patternBudget,
            bytes: rule.bytes,
            rule: rule.id,
          },
        },
      ),
  );
