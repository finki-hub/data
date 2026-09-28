// How a label names rows: `unique` when exactly one row carries it,
// `ambiguous` when several do, `missing` when none does, `none` when there
// is no label.
type Resolution = 'ambiguous' | 'missing' | 'none' | 'unique';

export type LinkCandidate = {
  readonly matches: readonly number[];
  readonly precedent: null | number;
  readonly resolution: Resolution;
};

export type LabelIndex = ReadonlyMap<string, readonly number[]>;

export const nonEmpty = (value: null | string | undefined): null | string =>
  (value ?? '') === '' ? null : (value ?? null);

// Ascending row ids per exact label, the shape every workbook lookup uses.
// Built through Map.groupBy: the ESLint autofix for the get-then-set pattern
// emits Map#getOrInsert, which Node 24 does not ship.
export const indexLabels = <T extends { readonly id: number }>(
  rows: readonly T[],
  label: (row: T) => null | string,
): LabelIndex => {
  const labelled = rows.flatMap((row) => {
    const key = label(row);
    return key === null ? [] : [{ id: row.id, key }];
  });
  return new Map(
    Map.groupBy(labelled, ({ key }) => key)
      .entries()
      .map(([key, items]) => [
        key,
        items.map(({ id }) => id).toSorted((left, right) => left - right),
      ]),
  );
};

const resolutionOf = (count: number): Resolution => {
  if (count === 0) {
    return 'missing';
  }
  return count === 1 ? 'unique' : 'ambiguous';
};

// The rows a label points at, with the first of them (the earliest row of
// the workbook) recorded as the precedent.
export const resolveLabel = (
  label: null | string,
  index: LabelIndex,
): LinkCandidate => {
  if (label === null) {
    return { matches: [], precedent: null, resolution: 'none' };
  }
  const matches = index.get(label) ?? [];
  return {
    matches,
    precedent: matches[0] ?? null,
    resolution: resolutionOf(matches.length),
  };
};

// The one row a label names, or null when it names none or several.
export const uniqueMatch = (link: LinkCandidate): null | number =>
  link.resolution === 'unique' ? link.precedent : null;

// Characters that change meaning inside a regular expression or a LIKE
// pattern; a course name carrying one matches differently than it reads.
export const metacharacterPattern = /[\\^$.*+?()[\]{}|%_]/u;

export const isValidPattern = (pattern: string): boolean => {
  try {
    new RegExp(pattern, 'u');
    return true;
  } catch {
    return false;
  }
};

export const groupIds = <T extends { readonly id: number }>(
  rows: readonly T[],
  key: (row: T) => null | string,
): ReadonlyArray<readonly number[]> =>
  indexLabels(rows, key)
    .values()
    .filter((ids) => ids.length > 1)
    .toArray();
