// How a label names rows: `unique` when exactly one row carries it,
// `repeated` when several rows carry it that list one and the same thing
// (a subject a curriculum sheet lists in several semester blocks,
// curriculum-labels.ts), `ambiguous` when several other rows do, `missing`
// when none does, `none` when there is no label.
type Resolution = 'ambiguous' | 'missing' | 'none' | 'repeated' | 'unique';

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

// The row a label links to: the one row it names, or the first of the
// rows that repeat one thing; null when it names none, or several that
// differ.
export const linkedRow = (link: LinkCandidate): null | number =>
  link.resolution === 'unique' || link.resolution === 'repeated'
    ? link.precedent
    : null;

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
