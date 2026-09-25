import {
  ruleModes,
  type RuleModeSpec,
} from '../../directus/extensions/directus-extension-data-operations/src/rule-modes.js';

// The expected enrollment counts of the stress fixture, computed in the
// test process from the generated histories, rules and mappings, with the
// semantics of each declared rule mode: a mode that reads a pattern counts
// the users whose raw history the pattern matches (`new RegExp(pattern,
// 'u')`, once per user), the other counts the distinct users holding an
// entry mapped to the rule's course and year. The entries are the lines
// the generator chose for each user (stressLines), never the raw text
// split again by the history contract the installed index runs. A pair
// without a rule has no count.

export type OracleRule = {
  readonly course: number;
  readonly mode: string;
  readonly pattern: null | string;
  readonly year: number;
};

export type OracleMapping = {
  readonly course: number;
  readonly label: string;
  readonly year: number;
};

export const pairKey = (course: number, year: number): string =>
  `${course}/${year}`;

// A pattern without regular-expression syntax or a line break matches
// exactly the raw histories that contain its text inside one line.
const syntax = /[\n\r$()*+.?[\\\]^{|}]/u;

// The generated users: each one's raw history and the lines it was built
// from (null for a null history), in row order.
export type OracleUsers = {
  readonly histories: ReadonlyArray<null | string>;
  readonly lines: ReadonlyArray<null | readonly string[]>;
};

type HistoryIndex = {
  // Every distinct line with the users (row positions) holding it.
  readonly byLine: ReadonlyMap<string, readonly number[]>;
  readonly histories: ReadonlyArray<null | string>;
};

const indexHistories = ({ histories, lines }: OracleUsers): HistoryIndex => {
  const byLine = new Map<string, number[]>();
  for (const [user, own] of lines.entries()) {
    const entries = new Set(own);
    for (const entry of entries) {
      const users = byLine.get(entry);
      if (users === undefined) {
        byLine.set(entry, [user]);
      } else {
        users.push(user);
      }
    }
  }
  return { byLine, histories };
};

const patternCount = (index: HistoryIndex, pattern: string): number => {
  if (pattern !== '' && !syntax.test(pattern)) {
    const users = new Set<number>();
    for (const [line, holders] of index.byLine) {
      if (line.includes(pattern)) {
        for (const user of holders) users.add(user);
      }
    }
    return users.size;
  }
  const matcher = new RegExp(pattern, 'u');
  return index.histories.filter(
    (history) => typeof history === 'string' && matcher.test(history),
  ).length;
};

const mappedCount = (
  index: HistoryIndex,
  labels: readonly string[],
): number => {
  const users = new Set<number>();
  for (const label of labels) {
    const holders = index.byLine.get(label) ?? [];
    for (const user of holders) users.add(user);
  }
  return users.size;
};

const modeOf = (mode: string, modes: readonly RuleModeSpec[]): RuleModeSpec => {
  const spec = modes.find((declared) => declared.mode === mode);
  if (spec === undefined) {
    throw new Error(`No rule mode ${mode} is declared`);
  }
  return spec;
};

// The count of every rule's pair, keyed `<course>/<year>`.
export const expectedCounts = (
  users: OracleUsers,
  {
    mappings,
    rules,
  }: {
    readonly mappings: readonly OracleMapping[];
    readonly rules: readonly OracleRule[];
  },
  modes: readonly RuleModeSpec[] = ruleModes,
): ReadonlyMap<string, number> => {
  const index = indexHistories(users);
  const mapped = Map.groupBy(mappings, ({ course, year }) =>
    pairKey(course, year),
  );
  const counts = new Map<string, number>();
  for (const rule of rules) {
    const key = pairKey(rule.course, rule.year);
    const count = modeOf(rule.mode, modes).usesPattern
      ? patternCount(index, rule.pattern ?? '')
      : mappedCount(
          index,
          (mapped.get(key) ?? []).map(({ label }) => label),
        );
    counts.set(key, count);
  }
  return counts;
};
