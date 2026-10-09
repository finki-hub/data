import {
  countPairs,
  type LabelledRow,
  type PatternMapping,
  resolveLines,
} from '../../directus/extensions/directus-extension-data-operations/src/enrollment-lines.js';

// The expected enrollment counts of the stress fixture, computed in the
// test process from the generated lines with the counting rules of
// enrollment-lines.ts (resolveLines, countPairs): every pattern mapping is
// tested against each distinct history line, an explicit mapping of a line
// replaces every pattern for it, and every course and academic year gets a
// count, 0 when no counted line holds a user. The lines are the ones the
// generator chose for each user (stressLines), never the raw text split
// again by the history contract the installed index runs.

// An explicit mapping by the label of its history line.
type OracleMapping = {
  readonly course: number;
  readonly label: string;
  readonly year: number;
};

export const pairKey = (course: number, year: number): string =>
  `${course}/${year}`;

// The count of every course and year, keyed `<course>/<year>`. History
// lines are numbered from 1 in the order they first occur; users by their
// row position.
export const expectedCounts = (
  users: { readonly lines: ReadonlyArray<null | readonly string[]> },
  sources: {
    readonly courses: readonly number[];
    readonly explicit: readonly OracleMapping[];
    readonly mappings: readonly PatternMapping[];
    readonly years: readonly LabelledRow[];
  },
): ReadonlyMap<string, number> => {
  const labels = [...new Set(users.lines.flatMap((own) => own ?? []))];
  const entries = new Map(labels.map((label, index) => [label, index + 1]));
  const entryOf = (label: string): number => entries.get(label) ?? 0;
  const counted = resolveLines({
    explicit: sources.explicit.map(({ course, label, year }) => ({
      academicYear: year,
      course,
      entry: entryOf(label),
    })),
    lines: labels.map((label) => ({ id: entryOf(label), label })),
    mappings: sources.mappings,
    years: sources.years,
  });
  const counts = countPairs({
    counted,
    courses: sources.courses.map((id) => ({ id })),
    memberships: users.lines.flatMap((own, user) =>
      [...new Set(own)].map((label) => ({
        entry: entryOf(label),
        moodleUser: user,
      })),
    ),
    years: sources.years,
  });
  return new Map(
    counts.map(({ academicYear, count, course }) => [
      pairKey(course, academicYear),
      count,
    ]),
  );
};
