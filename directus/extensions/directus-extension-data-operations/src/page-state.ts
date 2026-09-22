import { pageSize, textCollator } from './coordination/state.js';

// A candidate count staged under a claim and a page. Never a profile.
export type CountRow = {
  readonly academic_year: number;
  readonly count: number;
  readonly course: number;
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

// Splits the sorted, distinct source ids into consecutive ranges. The ids
// are read at the claimed revision; any later source change is refused at
// completion, so the plan never has to guess ids it did not see.
export const planPages = (
  ids: readonly number[],
  size: number = pageSize,
): PageRange[] => {
  const sorted = [...new Set(ids)].sort((left, right) => left - right);
  const pages: PageRange[] = [];
  for (let start = 0; start < sorted.length; start += size) {
    const chunk = sorted.slice(start, start + size);
    const from = chunk[0];
    const to = chunk.at(-1);
    if (from === undefined || to === undefined) {
      break;
    }
    pages.push({
      from,
      rows: chunk.length,
      to,
      token: pageToken(pages.length),
    });
  }
  return pages;
};

const pairKey = (row: CountRow): string => `${row.course}/${row.academic_year}`;

// Course/year pairs that occur more than once in one page payload. A page
// must aggregate its own rows; summing silently would hide a Flow bug.
export const duplicatePairs = (rows: readonly CountRow[]): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    const key = pairKey(row);
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
