import type { LiveData, LiveFile, PublicRow } from './fetch.js';

import { isYearLabel } from '../workbook-enrollment-reader.js';

// The live check's comparison of the live public files with the files
// projected from a workbook, as data: rows are paired by their match key,
// and every key of a pair is compared as text. Pure. What it answers holds
// course names, keys, counts and workbook places only: never a professors
// or assistants text, and never a staff or room value.

// The keys that pair a projected row with its live row: a course and a
// staff member by name, a room by location and name (room names repeat).
const matchKeys: Readonly<Record<LiveFile, readonly string[]>> = {
  'courses.json': ['name'],
  'rooms.json': ['location', 'name'],
  'staff.json': ['name'],
};

type Kind = 'differs' | 'liveOnly' | 'projectedOnly';

type Pair = { readonly live: PublicRow; readonly projected: PublicRow };

type Indexed = { readonly index: number; readonly row: PublicRow };

export type Comparison = {
  readonly live: LiveData;
  // The workbook place of each projected staff and room row, in row order.
  readonly places: Readonly<
    Record<'rooms.json' | 'staff.json', readonly string[]>
  >;
  readonly projected: LiveData;
  // Whether the year keys of courses.json are compared.
  readonly yearsCompared: boolean;
};

// How the rows of one file pair up. A row whose match key repeats on
// either side is neither paired nor compared; it is listed under the
// duplicates of its side, so every row is matched, on one side only or a
// duplicate.
const pairing = (file: LiveFile, sides: Comparison) => {
  const live = sides.live[file].map((row, index) => ({ index, row }));
  const projected = sides.projected[file].map((row, index) => ({
    index,
    row,
  }));
  const matchOf = ({ row }: Indexed) =>
    JSON.stringify(matchKeys[file].map((key) => row[key] ?? null));
  const liveGroups = Map.groupBy(live, matchOf);
  const projectedGroups = Map.groupBy(projected, matchOf);
  const repeated = (entry: Indexed) =>
    (liveGroups.get(matchOf(entry))?.length ?? 0) > 1 ||
    (projectedGroups.get(matchOf(entry))?.length ?? 0) > 1;
  const alone = (entry: Indexed, other: ReadonlyMap<string, unknown>) =>
    !repeated(entry) && !other.has(matchOf(entry));
  // In projected row order.
  const pairs = projected.flatMap((entry): Pair[] => {
    const [counterpart] = liveGroups.get(matchOf(entry)) ?? [];
    return repeated(entry) || counterpart === undefined
      ? []
      : [{ live: counterpart.row, projected: entry.row }];
  });
  return {
    duplicates: {
      live: live.filter(repeated),
      projected: projected.filter(repeated),
    },
    onlyLive: live.filter((entry) => alone(entry, projectedGroups)),
    onlyProjected: projected.filter((entry) => alone(entry, liveGroups)),
    pairs,
    rows: {
      live: live.length,
      matched: pairs.length,
      projected: projected.length,
    },
  };
};

const kindOf = (
  live: string | undefined,
  projected: string | undefined,
): Kind | null => {
  if (live === projected) {
    return null;
  }
  if (live === undefined) {
    return 'projectedOnly';
  }
  return projected === undefined ? 'liveOnly' : 'differs';
};

// Code-unit order: total and independent of the locale.
const byText = (left: string, right: string): number =>
  Number(left > right) - Number(left < right);

// Every compared key of a pair whose value differs, with how.
const differencesOf = (
  { live, projected }: Pair,
  compared: (key: string) => boolean,
): ReadonlyArray<{ readonly key: string; readonly kind: Kind }> =>
  [...new Set([...Object.keys(projected), ...Object.keys(live)])]
    .filter(compared)
    .flatMap((key) => {
      const kind = kindOf(live[key], projected[key]);
      return kind === null ? [] : [{ key, kind }];
    });

// What each differing key of the pairs lists per kind, keys in code-unit
// order, and the number of differing values. Built through Map.groupBy:
// the ESLint autofix for the get-then-set pattern emits Map#getOrInsert,
// which Node 24 does not ship.
const collect = <T>(
  pairs: readonly Pair[],
  compared: (key: string) => boolean,
  entry: (pair: Pair, key: string) => T,
) => {
  const found = pairs.flatMap((pair) =>
    differencesOf(pair, compared).map(({ key, kind }) => ({
      key,
      kind,
      value: entry(pair, key),
    })),
  );
  const listed = (items: typeof found, kind: Kind) =>
    items.filter((item) => item.kind === kind).map(({ value }) => value);
  const keys = Map.groupBy(found, ({ key }) => key)
    .entries()
    .map(
      ([key, items]) =>
        [
          key,
          {
            differs: listed(items, 'differs'),
            liveOnly: listed(items, 'liveOnly'),
            projectedOnly: listed(items, 'projectedOnly'),
          },
        ] as const,
    )
    .toArray()
    .toSorted(([left], [right]) => byText(left, right));
  return { differingValues: found.length, keys };
};

const nameOf = ({ row }: Indexed): string => row['name'] ?? '';

// courses.json by course name: the courses on one side only, the names
// that repeat, and per differing key the courses it differs on. A year key
// lists each course with both counts; while years are not compared, the
// year keys of either side are listed under notCompared instead.
const coursesReport = (sides: Comparison) => {
  const paired = pairing('courses.json', sides);
  const rows = [
    ...sides.live['courses.json'],
    ...sides.projected['courses.json'],
  ];
  const notCompared = sides.yearsCompared
    ? []
    : [...new Set(rows.flatMap((row) => Object.keys(row)))]
        .filter((key) => isYearLabel(key))
        .toSorted((left, right) => byText(left, right))
        .toReversed();
  const { differingValues, keys } = collect(
    paired.pairs,
    (key) => !notCompared.includes(key),
    ({ live, projected }, key) => {
      const course = projected['name'] ?? '';
      return isYearLabel(key)
        ? {
            course,
            live: live[key] ?? null,
            projected: projected[key] ?? null,
            year: key,
          }
        : course;
    },
  );
  return {
    differingValues,
    duplicateKeys: {
      live: [...new Set(paired.duplicates.live.map(nameOf))],
      projected: [...new Set(paired.duplicates.projected.map(nameOf))],
    },
    keys: Object.fromEntries(keys),
    notCompared,
    onlyLive: paired.onlyLive.map(nameOf),
    onlyProjected: paired.onlyProjected.map(nameOf),
    rows: paired.rows,
  };
};

// staff.json and rooms.json without a value: counts, and the workbook
// place of each projected row that is not paired.
const privateReport = (
  file: 'rooms.json' | 'staff.json',
  sides: Comparison,
) => {
  const paired = pairing(file, sides);
  const placeOf = ({ index }: Indexed) =>
    sides.places[file][index] ?? `projected row ${String(index + 1)}`;
  const { differingValues, keys } = collect(
    paired.pairs,
    () => true,
    () => null,
  );
  return {
    differingValues,
    duplicateKeys: {
      live: paired.duplicates.live.length,
      projected: paired.duplicates.projected.map(placeOf),
    },
    keys: Object.fromEntries(
      keys.map(([key, lists]) => [
        key,
        {
          differs: lists.differs.length,
          liveOnly: lists.liveOnly.length,
          projectedOnly: lists.projectedOnly.length,
        },
      ]),
    ),
    onlyLive: paired.onlyLive.length,
    onlyProjected: paired.onlyProjected.map(placeOf),
    rows: paired.rows,
  };
};

// Every live file compared with its projection.
export const compareLive = (sides: Comparison) => ({
  'courses.json': coursesReport(sides),
  'rooms.json': privateReport('rooms.json', sides),
  'staff.json': privateReport('staff.json', sides),
});
