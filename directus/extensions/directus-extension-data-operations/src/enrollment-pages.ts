import { coordinationError } from './coordination/errors.js';
import {
  type EnrollmentLimits,
  enrollmentLimits,
  historyRanges,
  type HistorySize,
  legacyRuleRanges,
  type Sized,
  type SizedRange,
} from './enrollment-ranges.js';
import { idRanges, type PageRange, pageToken } from './page-state.js';
import {
  alternatives,
  ruleModeNames,
  ruleModes,
  type RuleModeSpec,
  shownMode,
} from './rule-modes.js';

// The pages of one rule mode and the Flow that runs them all.
export type EnrollmentFamily = {
  readonly kind: string;
  readonly pages: readonly EnrollmentPage[];
  readonly runnerFlowId: string;
};

export type EnrollmentSources = {
  readonly rules: readonly RuleSize[];
  readonly users: readonly HistorySize[];
};

// One rule of course_enrollment_rules as the planner sees it: its id, mode
// and the UTF-8 bytes of its pattern, never its course, year or pattern.
export type RuleSize = {
  readonly bytes: number;
  readonly id: number;
  readonly mode: null | string;
};

// A page of one enrollments plan, its kind declared by its rule mode
// (rule-modes.ts). A rule page is a range of the mode's rules; a cross page
// crosses one history page with one rule page (from/to/rows/bytes name the
// users, rules the rule page and its pattern bytes); a zero page names one
// rule page, whose pairs without any count are staged as explicit zeros
// after all of its cross pages.
type EnrollmentPage =
  | (PageRange & {
      readonly bytes: number;
      readonly kind: string;
      readonly rules: SizedRange;
    })
  | (PageRange & { readonly kind: string });

// The rules of every declared mode. A rule of any other mode, or of none,
// refuses the whole plan, naming its id and a bounded mode only.
const rulesByMode = (
  rules: readonly RuleSize[],
  modes: readonly RuleModeSpec[],
): Map<string, Sized[]> => {
  const grouped = new Map<string, Sized[]>(modes.map(({ mode }) => [mode, []]));
  for (const rule of rules) {
    const family = rule.mode === null ? undefined : grouped.get(rule.mode);
    if (family === undefined) {
      throw coordinationError(
        'UNKNOWN_RULE_MODE',
        `Rule ${String(rule.id)}: mode ${shownMode(rule.mode, modes)}, expected ${alternatives(ruleModeNames(modes))}`,
        { details: { rule: rule.id } },
      );
    }
    family.push({ bytes: rule.bytes, id: rule.id });
  }
  return grouped;
};

type Planning = {
  readonly histories: () => readonly SizedRange[];
  readonly limits: EnrollmentLimits;
  readonly token: () => string;
};

// The pages of one mode's rules, as its planner cuts them: rule ranges, or
// per rule page every history page crossed with it and its zero page.
const familyPages = (
  spec: RuleModeSpec,
  rules: readonly Sized[],
  { histories, limits, token }: Planning,
): EnrollmentPage[] => {
  if (spec.planner === 'rule_ranges') {
    const [kind] = spec.pageKinds;
    const ids = rules.map(({ id }) => id);
    return idRanges(ids, limits.userPageSize).map((range) => ({
      ...range,
      kind,
      token: token(),
    }));
  }
  const [cross, zeros] = spec.pageKinds;
  const ruleRanges = legacyRuleRanges(rules, limits);
  const users = histories();
  return ruleRanges.flatMap((range): EnrollmentPage[] => [
    ...users.map((history) => ({
      ...history,
      kind: cross,
      rules: range,
      token: token(),
    })),
    {
      from: range.from,
      kind: zeros,
      rows: range.rows,
      to: range.to,
      token: token(),
    },
  ]);
};

// The one plan of an enrollments claim: one family per declared mode that
// has rules, in declaration order, its pages numbered on across families.
// Every page is tracked by the completion, so a family, a history page or
// a zero page that is not staged leaves the claim PAGES_MISSING instead of
// dropping the rows of that family. The histories are sized only for a
// family that crosses them.
export const planEnrollmentFamilies = (
  sources: EnrollmentSources,
  limits: EnrollmentLimits = enrollmentLimits,
  modes: readonly RuleModeSpec[] = ruleModes,
): EnrollmentFamily[] => {
  const grouped = rulesByMode(sources.rules, modes);
  let sized: SizedRange[] | undefined;
  let next = 0;
  const planning: Planning = {
    histories: () => {
      sized ??= historyRanges(sources.users, limits);
      return sized;
    },
    limits,
    token: () => {
      next += 1;
      return pageToken(next - 1);
    },
  };
  return modes.flatMap((spec) => {
    const rules = grouped.get(spec.mode) ?? [];
    return rules.length === 0
      ? []
      : [
          {
            kind: spec.mode,
            pages: familyPages(spec, rules, planning),
            runnerFlowId: spec.runnerFlowId,
          },
        ];
  });
};

// Every page of the plan, in the order its families run them.
export const planEnrollmentPages = (
  sources: EnrollmentSources,
  limits: EnrollmentLimits = enrollmentLimits,
  modes: readonly RuleModeSpec[] = ruleModes,
): EnrollmentPage[] =>
  planEnrollmentFamilies(sources, limits, modes).flatMap(({ pages }) => pages);
