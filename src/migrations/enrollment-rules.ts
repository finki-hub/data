import { splitHistoryEntries } from '../../directus/extensions/directus-extension-data-operations/src/history-contract.js';
import {
  boundedMatcher,
  type Matcher,
  type MatchOutcome,
  type MatchUser,
  proposalPatternTimeoutMs,
} from './bounded-match.js';
import { isValidPattern } from './labels.js';

// The regex-to-mapping conversion proposal of the legacy enrollment rules.
// The rules themselves are seeded by the `rules` converter (rules.ts, Task
// 8): one legacy_regex rule per course and academic year with the literal
// pattern the checkpoint compiled. This module only compares: for every
// rule whose course/year has explicit entry mappings the set of Moodle
// user ids the legacy expression matches with the set the mappings match,
// and for every superseded duplicate pattern row the set that row would
// have matched, each expression under a deadline (bounded-match.ts). The
// proposal carries counts and a few sample user ids, never a name, a
// history, a pattern or an entry label, and it never changes a rule.

export type ProposalRule = {
  readonly academicYear: string;
  // Superseded course_enrollment_patterns rows of the same course and year.
  readonly alternatives: ReadonlyArray<{
    readonly pattern: string;
    readonly row: number;
  }>;
  readonly course: number;
  readonly pattern: string;
};

// One explicit mapping of an exact history entry to a course and year.
export type ProposalMapping = {
  readonly academicYear: string;
  readonly course: number;
  readonly label: string;
};

export type ProposalInput = {
  readonly mappings: readonly ProposalMapping[];
  readonly rules: readonly ProposalRule[];
  readonly users: readonly MatchUser[];
};

export type AlternativeComparison = {
  readonly equal: boolean;
  readonly invalid: boolean;
  readonly onlyAlternative: number;
  readonly onlyChosen: number;
  readonly row: number;
  readonly sample: {
    readonly onlyAlternative: readonly number[];
    readonly onlyChosen: readonly number[];
  };
  readonly timedOut: boolean;
};

export type PairProposal = {
  readonly academicYear: string;
  readonly alternatives: readonly AlternativeComparison[];
  readonly course: number;
  // True only when the rule compiles, runs within the deadline and both
  // sets hold the same users.
  readonly equal: boolean;
  readonly invalid: boolean;
  readonly legacy: number;
  readonly mapped: number;
  readonly mappings: number;
  readonly onlyLegacy: number;
  readonly onlyMapped: number;
  readonly sample: {
    readonly onlyLegacy: readonly number[];
    readonly onlyMapped: readonly number[];
  };
  readonly timedOut: boolean;
};

export type ProposalSummary = {
  alternatives: number;
  compared: number;
  differing: number;
  equal: number;
  invalid: number;
  pairs: number;
  timedOut: number;
  unmapped: number;
};

export type MappingConversionProposal = {
  readonly note: string;
  readonly pairs: readonly PairProposal[];
  readonly summary: Readonly<ProposalSummary>;
};

export const proposalNote =
  'Proposal only: no enrollment rule was changed. A course/year converts to mapped_entries without changing its count only where equal is true; review every difference (sample user ids) before switching a rule in Studio, and keep legacy_regex where the expression needs several entries at once.';

const sampleSize = 5;

// The matched users of an outcome; none for an expression that does not
// compile or ran out of time (such a pair is never equal).
const matchedBy = (outcome: MatchOutcome): ReadonlySet<number> =>
  outcome.kind === 'matched' ? outcome.ids : new Set();

const difference = (
  left: ReadonlySet<number>,
  right: ReadonlySet<number>,
): number[] =>
  [...left].filter((id) => !right.has(id)).toSorted((a, b) => a - b);

const pairKey = (course: number, year: string): string =>
  `${course}\u{0}${year}`;

// The users of every mapped entry label, by the exact splitter the history
// index uses, so a mapped set is what mapped_entries would count.
const usersByLabel = (input: ProposalInput): Map<string, Set<number>> => {
  const wanted = new Set(input.mappings.map(({ label }) => label));
  const users = new Map<string, Set<number>>();
  for (const user of input.users) {
    for (const entry of splitHistoryEntries(user.Courses)) {
      if (wanted.has(entry)) {
        users.set(entry, new Set([...(users.get(entry) ?? []), user.id]));
      }
    }
  }
  return users;
};

const compareAlternative = (
  chosen: MatchOutcome,
  alternative: ProposalRule['alternatives'][number],
  match: Matcher,
): AlternativeComparison => {
  const outcome = match(alternative.pattern);
  const matched = matchedBy(outcome);
  const onlyChosen = difference(matchedBy(chosen), matched);
  const onlyAlternative = difference(matched, matchedBy(chosen));
  return {
    equal:
      outcome.kind === 'matched' &&
      chosen.kind === 'matched' &&
      onlyChosen.length === 0 &&
      onlyAlternative.length === 0,
    invalid: outcome.kind === 'invalid',
    onlyAlternative: onlyAlternative.length,
    onlyChosen: onlyChosen.length,
    row: alternative.row,
    sample: {
      onlyAlternative: onlyAlternative.slice(0, sampleSize),
      onlyChosen: onlyChosen.slice(0, sampleSize),
    },
    timedOut: outcome.kind === 'timed_out',
  };
};

type PairContext = {
  readonly labels: ReadonlySet<string>;
  readonly labelUsers: ReadonlyMap<string, ReadonlySet<number>>;
  readonly match: Matcher;
  readonly outcome: MatchOutcome;
};

// The legacy set of one rule against the set its mappings match, and the
// set of each superseded pattern row against the legacy set.
const comparePair = (
  rule: ProposalRule,
  { labels, labelUsers, match, outcome }: PairContext,
): PairProposal => {
  const legacy = matchedBy(outcome);
  const mapped = new Set(
    [...labels].flatMap((label) => [...(labelUsers.get(label) ?? [])]),
  );
  const onlyLegacy = difference(legacy, mapped);
  const onlyMapped = difference(mapped, legacy);
  return {
    academicYear: rule.academicYear,
    alternatives: rule.alternatives.map((alternative) =>
      compareAlternative(outcome, alternative, match),
    ),
    course: rule.course,
    equal:
      outcome.kind === 'matched' &&
      onlyLegacy.length === 0 &&
      onlyMapped.length === 0,
    invalid: outcome.kind === 'invalid',
    legacy: legacy.size,
    mapped: mapped.size,
    mappings: labels.size,
    onlyLegacy: onlyLegacy.length,
    onlyMapped: onlyMapped.length,
    sample: {
      onlyLegacy: onlyLegacy.slice(0, sampleSize),
      onlyMapped: onlyMapped.slice(0, sampleSize),
    },
    timedOut: outcome.kind === 'timed_out',
  };
};

const count = (condition: boolean): number => (condition ? 1 : 0);

// Every rule is counted; a pair is compared (and listed) when entries are
// mapped to it, and listed as well when its pattern does not compile or a
// superseded pattern row exists. The regular expressions run only for the
// listed pairs, each within `timeoutMs` over all histories.
export const proposeMappingConversion = (
  input: ProposalInput,
  timeoutMs: number = proposalPatternTimeoutMs,
): MappingConversionProposal => {
  const labelsByPair = Map.groupBy(input.mappings, ({ academicYear, course }) =>
    pairKey(course, academicYear),
  );
  const labelUsers = usersByLabel(input);
  const match = boundedMatcher(input.users, timeoutMs);
  const summary: ProposalSummary = {
    alternatives: 0,
    compared: 0,
    differing: 0,
    equal: 0,
    invalid: 0,
    pairs: input.rules.length,
    timedOut: 0,
    unmapped: 0,
  };
  const pairs: PairProposal[] = [];
  for (const rule of input.rules) {
    const labels = new Set(
      (labelsByPair.get(pairKey(rule.course, rule.academicYear)) ?? []).map(
        ({ label }) => label,
      ),
    );
    const invalid = !isValidPattern(rule.pattern);
    const mapped = labels.size > 0;
    summary.invalid += count(invalid);
    summary.alternatives += count(rule.alternatives.length > 0);
    summary.unmapped += count(!mapped);
    if (mapped || invalid || rule.alternatives.length > 0) {
      const outcome = match(rule.pattern);
      const pair = comparePair(rule, { labels, labelUsers, match, outcome });
      summary.compared += count(mapped);
      summary.equal += count(mapped && pair.equal);
      summary.differing += count(mapped && !pair.equal);
      summary.timedOut += [pair, ...pair.alternatives].filter(
        (compared) => compared.timedOut,
      ).length;
      pairs.push(pair);
    }
  }
  return { note: proposalNote, pairs, summary };
};
