// The enrollment rule modes (course_enrollment_rules.mode), declared once.
// The vocabulary stays closed: each mode has its own counting Flows, and a
// rule of any other mode refuses the whole enrollments plan. Everything
// else derives from this list: the model enum and its labels, the Studio
// notes, the enrollments planner (one family per mode that has rules), the
// check of a `rules` plan, the page kinds and rule filters of each family's
// Flows, and the calculation-graph roots of the fingerprint. The
// dispatcher reads none of it: it runs the planned families one by one
// through a runner whose Trigger Flow target is templated from the family,
// so adding or retiring a mode never edits an installed Flow. This module
// imports nothing, so the Studio app bundle can read it.

// How the rules of a mode are cut into pages. rule_ranges pages the rules
// by id (one page kind: the rule page a counting Flow reads whole);
// rules_x_histories crosses every rule page with every history page and
// adds one zero page per rule page (two page kinds, in that order).
export const rulePlanners = ['rule_ranges', 'rules_x_histories'] as const;

// One declared mode: the stored value and its Studio label, what a rule of
// the mode does (the field notes), whether it reads `pattern`, how it is
// planned, and the Flow that runs its whole family of pages (its answer is
// {ok: true, ...} or {ok: false, stage, code, message}).
export type RuleModeSpec = PlannerPages & {
  readonly description: string;
  readonly label: string;
  readonly mode: string;
  readonly runnerFlowId: string;
  readonly usesPattern: boolean;
};

type PlannerPages =
  | {
      readonly pageKinds: readonly [string, string];
      readonly planner: 'rules_x_histories';
    }
  | { readonly pageKinds: readonly [string]; readonly planner: 'rule_ranges' };

export const ruleModes = [
  {
    description: 'counts explicit mappings',
    label: 'Mapped entries',
    mode: 'mapped_entries',
    pageKinds: ['mapped'],
    planner: 'rule_ranges',
    runnerFlowId: '6a1d9f0e-2b3c-4d5e-8f70-000000001103',
    usesPattern: false,
  },
  {
    description: 'applies the retained pattern',
    label: 'Legacy regex',
    mode: 'legacy_regex',
    pageKinds: ['legacy', 'legacy_zeros'],
    planner: 'rules_x_histories',
    runnerFlowId: '6a1d9f0e-2b3c-4d5e-8f70-000000001201',
    usesPattern: true,
  },
] as const satisfies readonly RuleModeSpec[];

type Declared = (typeof ruleModes)[number];

type RuleModeName = Declared['mode'];

// The declaration of one mode, for the Flows of its family.
export const ruleMode = <Name extends RuleModeName>(
  name: Name,
): Extract<Declared, { readonly mode: Name }> => {
  const found = ruleModes.find(
    (entry): entry is Extract<Declared, { readonly mode: Name }> =>
      entry.mode === name,
  );
  if (found === undefined) {
    throw new Error(`Rule mode ${name} is not declared`);
  }
  return found;
};

export const ruleModeNames = (
  modes: readonly RuleModeSpec[] = ruleModes,
): string[] => modes.map(({ mode }) => mode);

// The one mode a `rules` plan (plain rule-id ranges, no page kind) may
// page: the page Flow that counts such a plan belongs to this mode's
// family and reads its own mode's rules only, so the coordinator takes a
// `rules` plan only while every rule has this mode. It must be planned as
// rule ranges; any other mode, even one planned the same way, plans with
// source `enrollments`.
export const rulesPlanMode: Extract<
  Declared,
  { readonly planner: 'rule_ranges' }
> = ruleMode('mapped_entries');

// The Flows that run a family: every one is a root of the calculation
// graph, since the dispatcher reaches it through a templated flow id.
export const runnerFlowIds = (
  modes: readonly RuleModeSpec[] = ruleModes,
): string[] => modes.map(({ runnerFlowId }) => runnerFlowId);

// "a or b", "a, b or c": the modes a refusal expects.
export const alternatives = (values: readonly string[]): string => {
  const last = values.at(-1);
  return last === undefined || values.length === 1
    ? values.join('')
    : `${values.slice(0, -1).join(', ')} or ${last}`;
};

// A stored rule mode in a refusal: a declared mode as it is, any other
// value quoted and bounded, a missing one as none.
export const shownMode = (
  mode: null | string,
  modes: readonly RuleModeSpec[] = ruleModes,
): string => {
  if (mode === null) {
    return 'none';
  }
  return modes.some((entry) => entry.mode === mode)
    ? mode
    : JSON.stringify(mode.slice(0, 40));
};
