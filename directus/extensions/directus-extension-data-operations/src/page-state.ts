import { pageSize, textCollator } from './coordination/state.js';

// A match staged under a claim and a page: a history line a pattern
// mapping matches, with the academic year `<start>/<start+1>` its year
// pattern reads from the line, or null for an only-in-year mapping. Never
// a label or a pattern.
export type MatchRow = {
  readonly entry: number;
  readonly pattern_mapping: number;
  readonly year_label: null | string;
};

// A planned page: the inclusive id range of at most `pageSize` source rows
// a calculation Flow processes in one step, named by its page token.
export type PageRange = {
  readonly from: number;
  readonly rows: number;
  readonly to: number;
  readonly token: string;
};

export const pageTokenPattern = /^p\d{4,9}$/u;

export const pageToken = (index: number): string =>
  `p${String(index + 1).padStart(4, '0')}`;

// The inclusive id range of consecutive source rows and how many rows it
// holds.
export type IdRange = Omit<PageRange, 'token'>;

// Splits the sorted, distinct ids into consecutive ranges of at most
// `size` rows.
export const idRanges = (ids: readonly number[], size: number): IdRange[] => {
  const sorted = [...new Set(ids)].sort((left, right) => left - right);
  const ranges: IdRange[] = [];
  for (let start = 0; start < sorted.length; start += size) {
    const chunk = sorted.slice(start, start + size);
    const from = chunk[0];
    const to = chunk.at(-1);
    if (from === undefined || to === undefined) {
      break;
    }
    ranges.push({ from, rows: chunk.length, to });
  }
  return ranges;
};

// Splits the source ids into consecutive planned pages. The ids are read
// at the claimed revision; any later source change is refused at
// completion, so the plan never has to guess ids it did not see.
export const planPages = (
  ids: readonly number[],
  size: number = pageSize,
): PageRange[] =>
  idRanges(ids, size).map((range, index) => ({
    ...range,
    token: pageToken(index),
  }));

const matchKey = (row: MatchRow): string =>
  `entry ${row.entry} / pattern mapping ${row.pattern_mapping}`;

// Line/mapping pairs that occur more than once in one page payload: a
// mapping matches a line once, so a repeated pair is a Flow bug.
export const duplicateMatches = (rows: readonly MatchRow[]): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    const key = matchKey(row);
    if (seen.has(key)) {
      duplicates.add(key);
    }
    seen.add(key);
  }
  return [...duplicates].sort((left, right) =>
    textCollator.compare(left, right),
  );
};

export const missingPages = (
  planned: readonly string[],
  staged: readonly string[],
): string[] => {
  const done = new Set(staged);
  return planned.filter((page) => !done.has(page));
};

export const stagedWith = (staged: readonly string[], page: string): string[] =>
  [...new Set([...staged, page])].sort((left, right) =>
    textCollator.compare(left, right),
  );
