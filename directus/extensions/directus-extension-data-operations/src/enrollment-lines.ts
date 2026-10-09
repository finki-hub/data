// The counting rules, declared once: which course and academic year a
// Moodle history line counts for, and the count of every course and year.
// Pure: it imports nothing. directus/flows/match-history-lines.cjs copies
// its mapping checks and year rule; unit tests run both on the same inputs.

// A new mapping's year pattern: it reads "Математика 1-2025/2026/Z".
export const defaultYearPattern = String.raw`(?<start>\d{4})/(?<end>\d{4})`;

const metacharacters = /[$()*+.?[\\\]^{|}]/gu;

// A course's default pattern: its name, metacharacters escaped, then `-`.
export const defaultPattern = (name: string): string => {
  const escaped = name.replaceAll(metacharacters, String.raw`\$&`);
  return `${escaped}-`;
};

// Why a text does not compile as a Unicode regular expression, or null,
// without the pattern V8 quotes: `Invalid regular expression: /…/u: <reason>`.
export const patternProblem = (text: string): null | string => {
  try {
    new RegExp(text, 'u');
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return (message.split(': ').at(-1) ?? 'invalid').slice(0, 80);
  }
};

// Why a text cannot be a year pattern, or null: it must compile and declare
// a group named start or end. With an empty alternative added, it matches
// the empty text, and the match lists every group it declares.
export const yearPatternProblem = (text: string): null | string => {
  const problem = patternProblem(text);
  if (problem !== null) {
    return problem;
  }
  const groups = new RegExp(`${text}|`, 'u').exec('')?.groups ?? {};
  return 'start' in groups || 'end' in groups
    ? null
    : 'no group named start or end';
};

const capturedYear = /^(?:\d{2}|\d{4})$/u;

// A captured year: 4 digits as written, 2 digits as 20xx, NaN for any other
// capture; undefined when the group did not take part.
const yearValue = (text: string | undefined): number | undefined => {
  if (text === undefined || !capturedYear.test(text)) {
    return text === undefined ? undefined : NaN;
  }
  return text.length === 2 ? 2_000 + Number(text) : Number(text);
};

// The academic-year label a compiled year pattern reads from a line.
const yearIn = (matcher: RegExp, label: string): null | string => {
  const groups = matcher.exec(label)?.groups ?? {};
  const end = yearValue(groups['end']);
  const first =
    yearValue(groups['start']) ?? (end === undefined ? NaN : end - 1);
  return Number.isSafeInteger(first) && (end === undefined || end === first + 1)
    ? `${String(first)}/${String(first + 1)}`
    : null;
};

// The academic year `<start>/<start+1>` a year pattern reads from a whole
// history line: the groups start and end of its first match, each 2 or 4
// ASCII digits. Null when nothing matches, when neither group took part,
// when a capture has another form, or when the two years are not
// consecutive. The year pattern must compile (yearPatternProblem).
export const lineYear = (yearPattern: string, label: string): null | string =>
  yearIn(new RegExp(yearPattern, 'u'), label);

// What counts a line: an explicit mapping of it, or a pattern mapping.
export const countedLineSources = ['explicit', 'pattern'] as const;

// One row of moodle_counted_lines.
export type CountedLine = {
  readonly academicYear: number;
  readonly course: number;
  readonly entry: number;
  readonly patternMapping: null | number;
  readonly source: (typeof countedLineSources)[number];
};

// An explicit mapping of one history line to a course and academic year.
export type ExplicitMapping = Omit<CountedLine, 'patternMapping' | 'source'>;

// A history line (moodle_course_entries) or an academic year.
export type LabelledRow = { readonly id: number; readonly label: string };

export type LineSources = {
  readonly explicit: readonly ExplicitMapping[];
  readonly lines: readonly LabelledRow[];
  readonly mappings: readonly PatternMapping[];
  readonly years: readonly LabelledRow[];
};

// A pattern mapping: exactly one of yearPattern (all years) and onlyInYear
// (an academic year id) is set, as the database CHECK requires.
export type PatternMapping = Readonly<{
  course: number;
  id: number;
  onlyInYear: null | number;
  pattern: string;
  yearPattern: null | string;
}>;

// The academic year ids by label, and the course/year pairs in which an
// only-in-year mapping replaces the course's all-years mappings.
type YearContext = {
  readonly replaced: ReadonlySet<string>;
  readonly yearIds: ReadonlyMap<string, number>;
};

const pairKey = (course: number, academicYear: number): string =>
  `${String(course)}/${String(academicYear)}`;

// Unusable fields, as the database CHECKs and the matcher Run Script see
// them: no pattern, or not exactly one of a year pattern and a year id.
const shapeFault = (mapping: PatternMapping): null | string => {
  const { onlyInYear, pattern, yearPattern } = mapping;
  if (pattern === '') {
    return 'pattern missing';
  }
  const yearId = Number.isSafeInteger(onlyInYear) && (onlyInYear ?? 0) > 0;
  const oneSet =
    yearPattern === null ? yearId : yearPattern !== '' && onlyInYear === null;
  return oneSet ? null : 'expected exactly one of year_pattern, only_in_year';
};

// Unusable patterns: an invalid pattern or year pattern.
const compileFault = (mapping: PatternMapping): null | string => {
  const { pattern, yearPattern } = mapping;
  const problem = patternProblem(pattern);
  if (problem !== null) {
    return `invalid regular expression (${problem})`;
  }
  const yearProblem =
    yearPattern === null ? null : yearPatternProblem(yearPattern);
  return yearProblem === null ? null : `invalid year pattern (${yearProblem})`;
};

// The first unusable mapping fails the resolution, named by its id as the
// matcher Run Script names it: every mapping's fields before any compiles.
const checkMappings = (mappings: readonly PatternMapping[]): void => {
  for (const fault of [shapeFault, compileFault]) {
    for (const mapping of mappings) {
      const problem = fault(mapping);
      if (problem !== null) {
        throw new Error(`Pattern mapping ${String(mapping.id)}: ${problem}`);
      }
    }
  }
};

// The rows one checked mapping counts a line with, its pattern and year
// pattern compiled once.
const lineCounter = (
  mapping: PatternMapping,
  { replaced, yearIds }: YearContext,
): ((line: LabelledRow) => CountedLine[]) => {
  const { course, id, onlyInYear, pattern, yearPattern } = mapping;
  const matcher = new RegExp(pattern, 'u');
  const year = yearPattern === null ? null : new RegExp(yearPattern, 'u');
  const row = { course, patternMapping: id, source: 'pattern' as const };
  return ({ id: entry, label }) => {
    if (!matcher.test(label)) {
      return [];
    }
    const yearLabel = year === null ? null : yearIn(year, label);
    const academicYear =
      onlyInYear ?? (yearLabel === null ? undefined : yearIds.get(yearLabel));
    return academicYear === undefined ||
      (year !== null && replaced.has(pairKey(course, academicYear)))
      ? []
      : [{ ...row, academicYear, entry }];
  };
};

const byRow = (left: CountedLine, right: CountedLine): number =>
  left.entry - right.entry ||
  left.course - right.course ||
  left.academicYear - right.academicYear ||
  (left.patternMapping ?? 0) - (right.patternMapping ?? 0);

// The counted lines, decided per history line (`^` is the line start):
// 1. a line with an explicit mapping counts exactly for its explicit
//    mappings; every pattern mapping is ignored for it;
// 2. an only-in-year mapping counts each line its pattern matches for its
//    course and year, whatever year the line shows;
// 3. an all-years mapping counts a line its pattern matches for its course
//    and the year lineYear reads, unless that reads none, no academic year
//    has that label, or the course has an only-in-year mapping that year.
// One row per explicit mapping, and per line and pattern mapping, ordered
// by line, course, year and mapping.
export const resolveLines = (sources: LineSources): CountedLine[] => {
  const { explicit, lines, mappings, years } = sources;
  checkMappings(mappings);
  const context: YearContext = {
    replaced: new Set(
      mappings.flatMap(({ course, onlyInYear }) =>
        onlyInYear === null ? [] : [pairKey(course, onlyInYear)],
      ),
    ),
    yearIds: new Map(years.map(({ id, label }) => [label, id])),
  };
  const counters = mappings.map((mapping) => lineCounter(mapping, context));
  const explicitLines = new Set(explicit.map(({ entry }) => entry));
  return [
    ...explicit.map((row): CountedLine => ({
      ...row,
      patternMapping: null,
      source: 'explicit',
    })),
    ...lines
      .filter(({ id }) => !explicitLines.has(id))
      .flatMap((line) => counters.flatMap((counter) => counter(line))),
  ].toSorted(byRow);
};

// A Moodle user carrying a history line (moodle_history_memberships).
export type Membership = Readonly<{ entry: number; moodleUser: number }>;

// One row of course_enrollments.
export type PairCount = Readonly<{
  academicYear: number;
  count: number;
  course: number;
}>;

export type PairSources = Readonly<{
  counted: readonly CountedLine[];
  courses: ReadonlyArray<{ readonly id: number }>;
  memberships: readonly Membership[];
  years: ReadonlyArray<{ readonly id: number }>;
}>;

// The count of every course and academic year, in course, then year order:
// the distinct Moodle users holding a line counted for that pair, 0 when
// none does. Counted lines of a course or year not listed are ignored.
export const countPairs = (sources: PairSources): PairCount[] => {
  const holders = Map.groupBy(sources.memberships, ({ entry }) => entry);
  const linesOf = Map.groupBy(sources.counted, ({ academicYear, course }) =>
    pairKey(course, academicYear),
  );
  const usersOf = (lines: readonly CountedLine[]): Set<number> =>
    new Set(
      lines.flatMap(({ entry }) =>
        (holders.get(entry) ?? []).map(({ moodleUser }) => moodleUser),
      ),
    );
  return sources.courses.flatMap((course) =>
    sources.years.map((year) => ({
      academicYear: year.id,
      count: usersOf(linesOf.get(pairKey(course.id, year.id)) ?? []).size,
      course: course.id,
    })),
  );
};
