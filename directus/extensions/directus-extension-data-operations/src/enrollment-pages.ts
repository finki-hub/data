import { coordinationError } from './coordination/errors.js';
import {
  historyPageBudget,
  legacyPatternBudget,
  legacyRulePageSize,
  pageSize,
} from './coordination/state.js';
import {
  type IdRange,
  idRanges,
  type PageRange,
  pageToken,
} from './page-state.js';

export type EnrollmentLimits = {
  readonly budget: number;
  readonly patternBudget: number;
  readonly rulePageSize: number;
  readonly userPageSize: number;
};

// The pages of one enrollments plan. A mapped page is a range of
// mapped_entries rules (Task 11 page Flow); a legacy page crosses one
// history page with one legacy rule page (from/to/rows/bytes name the
// users, rules the rule page and its pattern bytes); a zero page names one
// legacy rule page, whose pairs without any count are staged as explicit
// zeros after all of its legacy pages.
export type EnrollmentPage =
  | (PageRange & {
      readonly bytes: number;
      readonly kind: 'legacy';
      readonly rules: SizedRange;
    })
  | (PageRange & { readonly kind: 'legacy_zeros' })
  | (PageRange & { readonly kind: 'mapped' });

export type EnrollmentSources = {
  readonly rules: readonly RuleMode[];
  readonly users: readonly HistorySize[];
};

// One Moodle user: its id and the UTF-8 bytes of its raw `Courses` text,
// never the text itself.
export type HistorySize = { readonly bytes: number; readonly id: number };

// One rule of course_enrollment_rules as the planner sees it: its id, mode
// and the UTF-8 bytes of its pattern, never its course, year or pattern.
export type RuleMode = {
  readonly bytes: number;
  readonly id: number;
  readonly mode: null | string;
};

// Consecutive rows of at most a row count and a byte budget: a history
// page of the legacy family or a legacy rule page.
export type SizedRange = IdRange & { readonly bytes: number };

export const enrollmentLimits: EnrollmentLimits = {
  budget: historyPageBudget,
  patternBudget: legacyPatternBudget,
  rulePageSize: legacyRulePageSize,
  userPageSize: pageSize,
};

const shownMode = (mode: null | string): string =>
  mode === null ? 'none' : JSON.stringify(mode.slice(0, 40));

type Sized = { readonly bytes: number; readonly id: number };

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
        `Moodle user ${user.id} holds ${user.bytes} bytes of Courses history, more than the ${limits.budget}-byte budget of one legacy rule page; nothing was planned.`,
        {
          details: { budget: limits.budget, bytes: user.bytes, user: user.id },
        },
      ),
  );

// Splits the legacy rules into consecutive pages of at most
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
        `Rule ${rule.id} holds a pattern of ${rule.bytes} bytes, more than the ${limits.patternBudget}-byte pattern budget of one legacy rule page; nothing was planned.`,
        {
          details: {
            budget: limits.patternBudget,
            bytes: rule.bytes,
            rule: rule.id,
          },
        },
      ),
  );

const rulesByMode = (
  rules: readonly RuleMode[],
): { readonly legacy: Sized[]; readonly mapped: number[] } => {
  const legacy: Sized[] = [];
  const mapped: number[] = [];
  for (const rule of rules) {
    if (rule.mode === 'mapped_entries') {
      mapped.push(rule.id);
    } else if (rule.mode === 'legacy_regex') {
      legacy.push({ bytes: rule.bytes, id: rule.id });
    } else {
      throw coordinationError(
        'UNKNOWN_RULE_MODE',
        `Rule ${rule.id} has the mode ${shownMode(rule.mode)}; every enrollment rule must be mapped_entries or legacy_regex, so nothing was planned.`,
        { details: { rule: rule.id } },
      );
    }
  }
  return { legacy, mapped };
};

// The one plan of an enrollments claim, in the order its pages run: every
// mapped rule page, then per legacy rule page every history page crossed
// with it and its zero page. Every page is tracked by the completion, so
// omitting a family, a history page or a zero page leaves the claim
// PAGES_MISSING instead of dropping the rows of that family.
export const planEnrollmentPages = (
  sources: EnrollmentSources,
  limits: EnrollmentLimits = enrollmentLimits,
): EnrollmentPage[] => {
  const { legacy, mapped } = rulesByMode(sources.rules);
  const ruleRanges = legacyRuleRanges(legacy, limits);
  const histories = historyRanges(sources.users, limits);
  const pages: EnrollmentPage[] = [];
  for (const range of idRanges(mapped, limits.userPageSize)) {
    pages.push({ ...range, kind: 'mapped', token: pageToken(pages.length) });
  }
  for (const rules of ruleRanges) {
    for (const users of histories) {
      pages.push({
        ...users,
        kind: 'legacy',
        rules,
        token: pageToken(pages.length),
      });
    }
    pages.push({
      from: rules.from,
      kind: 'legacy_zeros',
      rows: rules.rows,
      to: rules.to,
      token: pageToken(pages.length),
    });
  }
  return pages;
};
