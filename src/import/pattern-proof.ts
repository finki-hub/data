import type { CourseMappings } from './pattern-join.js';

import {
  defaultPattern,
  defaultYearPattern,
  lineYear,
  type PatternMapping,
  resolveLines,
} from '../../directus/extensions/directus-extension-data-operations/src/enrollment-lines.js';

// The history lines of the workbook's Moodle snapshot and what the typed
// Слушатели cells count among them (plan step 13): the line sets the
// conversion compares, and the proof that the converted mappings count
// them.

// The distinct history lines with cached matches: the lines a pattern
// matches (any year), and the workbook academic year a year pattern reads
// from each line (null for none, or for a year the workbook does not head).
export type LineSets = {
  readonly lines: readonly string[];
  readonly matched: (pattern: string) => readonly number[];
  readonly years: readonly string[];
  readonly yearsOf: (yearPattern: string) => ReadonlyArray<null | string>;
};

export const lineSets = (
  lines: readonly string[],
  years: readonly string[],
): LineSets => {
  const matches = new Map<string, readonly number[]>();
  const readYears = new Map<string, ReadonlyArray<null | string>>();
  const known = new Set(years);
  return {
    lines,
    matched: (pattern) => {
      const cached = matches.get(pattern);
      if (cached !== undefined) {
        return cached;
      }
      const expression = new RegExp(pattern, 'u');
      const found = lines.flatMap((line, index) =>
        expression.test(line) ? [index] : [],
      );
      matches.set(pattern, found);
      return found;
    },
    years,
    yearsOf: (yearPattern) => {
      const cached = readYears.get(yearPattern);
      if (cached !== undefined) {
        return cached;
      }
      const found = lines.map((line) => {
        const year = lineYear(yearPattern, line);
        return year !== null && known.has(year) ? year : null;
      });
      readYears.set(yearPattern, found);
      return found;
    },
  };
};

// A course of the conversion: its row, name, and its typed cells by
// academic year (line breaks removed), each with its pattern row.
export type PatternCourse = {
  readonly cells: ReadonlyMap<string, TypedCell>;
  readonly id: number;
  readonly name: string;
};

export type TypedCell = {
  readonly academicYear: string;
  readonly pattern: string;
  readonly row: number;
};

// What the spreadsheet counted for a course and year: the lines its typed
// cell matches (any year), else the lines `<escaped name>-` matches whose
// year under the default year pattern is that year.
export const designLines = (
  sets: LineSets,
  course: PatternCourse,
  year: string,
): readonly number[] => {
  const cell = course.cells.get(year);
  if (cell !== undefined) {
    return sets.matched(cell.pattern);
  }
  const years = sets.yearsOf(defaultYearPattern);
  return sets
    .matched(defaultPattern(course.name))
    .filter((index) => years[index] === year);
};

// Whether the conversion must keep a course's year exactly (decision B):
// every year but the newest workbook year of a course without a typed
// cell in it, which the spreadsheet had no cell for yet.
export const isCompared = (
  sets: LineSets,
  course: PatternCourse,
  year: string,
): boolean => year !== sets.years[0] || course.cells.has(year);

export class PatternConversionError extends Error {
  public override readonly name = 'PatternConversionError';
}

// One course's converted mappings in the shape resolveLines reads, years
// by their position in the workbook (newest first, from 1).
const resolvable = (
  sets: LineSets,
  { course, mappings }: ConvertedCourse,
  first: number,
): PatternMapping[] =>
  [
    ...mappings.allYears.entries().map(([yearPattern, alternatives]) => ({
      onlyInYear: null,
      pattern: alternatives.join('|'),
      yearPattern,
    })),
    ...mappings.onlyInYear.entries().map(([year, pattern]) => ({
      onlyInYear: sets.years.indexOf(year) + 1,
      pattern,
      yearPattern: null,
    })),
  ].map((mapping, index) => ({
    ...mapping,
    course: course.id,
    id: first + index,
  }));

export type ConvertedCourse = {
  readonly course: PatternCourse;
  readonly mappings: CourseMappings;
};

const sameLines = (left: ReadonlySet<number>, right: readonly number[]) =>
  left.size === right.length && right.every((line) => left.has(line));

// The proof before anything is written: resolved by the counting rules
// (resolveLines), every compared course and year counts exactly the
// design's lines, and every other one at least those. Answers the pairs
// that count more (the warning newest_year_widened); any other difference
// fails the import.
export const provePatternMappings = (
  sets: LineSets,
  converted: readonly ConvertedCourse[],
): ReadonlyArray<{ readonly course: PatternCourse; readonly year: string }> => {
  const mappings: PatternMapping[] = [];
  for (const course of converted) {
    mappings.push(...resolvable(sets, course, mappings.length + 1));
  }
  const counted = resolveLines({
    explicit: [],
    lines: sets.lines.map((label, index) => ({ id: index, label })),
    mappings,
    years: sets.years.map((label, index) => ({ id: index + 1, label })),
  });
  const linesOf = Map.groupBy(
    counted,
    ({ academicYear, course }) => `${String(course)}/${String(academicYear)}`,
  );
  return converted.flatMap(({ course }) =>
    sets.years.flatMap((year, index) => {
      const lines = new Set(
        (linesOf.get(`${String(course.id)}/${String(index + 1)}`) ?? []).map(
          ({ entry }) => entry,
        ),
      );
      const design = designLines(sets, course, year);
      if (sameLines(lines, design)) {
        return [];
      }
      if (
        isCompared(sets, course, year) ||
        design.some((line) => !lines.has(line))
      ) {
        throw new PatternConversionError(
          `pattern conversion "${course.name}" ${year}: line set mismatch`,
        );
      }
      return [{ course, year }];
    }),
  );
};
