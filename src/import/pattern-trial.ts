import { patternProblem } from '../../directus/extensions/directus-extension-data-operations/src/enrollment-lines.js';
import {
  type Alternative,
  type CourseMappings,
  mappingCount,
  withAlternatives,
} from './pattern-join.js';
import {
  isCompared,
  type LineSets,
  type PatternCourse,
  type TypedCell,
} from './pattern-proof.js';
import {
  branchesOf,
  type BranchKind,
  branchYearPattern,
  generalisedBranch,
} from './pattern-templates.js';

// The trial of a conversion of a course's typed cells (plan step 13): it
// accepts a conversion only when every compared year keeps its lines.

// A course under conversion: its design (the lines the spreadsheet counted
// per year, as a key) and the history lines.
export type Trial = {
  readonly course: PatternCourse;
  readonly design: ReadonlyMap<string, string>;
  readonly sets: LineSets;
};

export const startYear = (year: string): number => Number(year.slice(0, 4));

export const keyOf = (lines: Iterable<number>): string =>
  [...lines].toSorted((left, right) => left - right).join(',');

// The year pattern of a branch of a cell, from the lines it matches; null
// when the branch is no pattern of its own or names no year of the cell.
export const branchYear = (
  sets: LineSets,
  branch: string,
  start: number,
): null | string =>
  patternProblem(branch) === null
    ? branchYearPattern(
        branch,
        start,
        sets.matched(branch).map((line) => sets.lines[line] ?? ''),
      )
    : null;

// The compared years whose lines under the mappings differ from the
// design, by the counting rules of plan 1.3.
const changedYears = (
  { course, design, sets }: Trial,
  { allYears, onlyInYear }: CourseMappings,
): readonly string[] => {
  const lines = new Map<string, Set<number>>();
  const add = (year: string, line: number) => {
    lines.set(year, (lines.get(year) ?? new Set()).add(line));
  };
  for (const [yearPattern, alternatives] of allYears) {
    const years = sets.yearsOf(yearPattern);
    const matched = alternatives.flatMap((pattern) => sets.matched(pattern));
    for (const line of matched) {
      const year = years[line] ?? null;
      if (year !== null && !onlyInYear.has(year)) {
        add(year, line);
      }
    }
  }
  for (const [year, pattern] of onlyInYear) {
    for (const line of sets.matched(pattern)) {
      add(year, line);
    }
  }
  return sets.years.filter(
    (year) =>
      isCompared(sets, course, year) &&
      keyOf(lines.get(year) ?? []) !== design.get(year),
  );
};

// The generalised branches of the cells and their year patterns, or null
// when a branch cannot generalise this way. A branch that counts no line
// under its year pattern is left out.
const alternativesOf = (
  { sets }: Trial,
  cells: readonly TypedCell[],
  kind: BranchKind,
): null | readonly Alternative[] => {
  const alternatives: Alternative[] = [];
  for (const cell of cells) {
    const start = startYear(cell.academicYear);
    for (const branch of branchesOf(cell.pattern)) {
      const generalised = generalisedBranch(branch, start, kind);
      const yearPattern = branchYear(sets, branch, start);
      if (generalised === null || yearPattern === null) {
        return null;
      }
      alternatives.push({ branch: generalised, yearPattern });
    }
  }
  return alternatives.filter(({ branch, yearPattern }) => {
    const years = sets.yearsOf(yearPattern);
    return sets.matched(branch).some((line) => years[line] !== null);
  });
};

export type Converted = {
  readonly cells: readonly TypedCell[];
  readonly mappings: CourseMappings;
};

// One trial of the cells of the given years: their generalised branches
// joined and their only-in-year mappings gone. Answers the conversion, the
// years whose lines changed, or null when the cells cannot generalise this
// way or a year outside the group changed (spill).
const trialOf = (
  trial: Trial,
  mappings: CourseMappings,
  {
    cells,
    kind,
    years,
  }: {
    readonly cells: readonly TypedCell[];
    readonly kind: BranchKind;
    readonly years: ReadonlySet<string>;
  },
): null | {
  readonly changed: readonly string[];
  readonly converted: Converted;
} => {
  const current = cells.filter(({ academicYear }) => years.has(academicYear));
  const alternatives = alternativesOf(trial, current, kind);
  if (alternatives === null) {
    return null;
  }
  const converted: CourseMappings = {
    allYears: withAlternatives(mappings, alternatives).allYears,
    onlyInYear: new Map(
      [...mappings.onlyInYear].filter(([year]) => !years.has(year)),
    ),
  };
  const changed = changedYears(trial, converted);
  return changed.some((year) => !years.has(year))
    ? null
    : { changed, converted: { cells: current, mappings: converted } };
};

const withoutYears = (
  years: ReadonlySet<string>,
  changed: readonly string[],
): ReadonlySet<string> =>
  new Set([...years].filter((year) => !changed.includes(year)));

// Converts what it can of a group of cells. A change outside the group's
// years refuses the kind (spill); no change accepts the conversion when
// the course has fewer mappings, else refuses it (no gain); otherwise the
// changed years leave the group and it tries again (a partial merge).
export const tryCells = (
  trial: Trial,
  mappings: CourseMappings,
  {
    cells,
    kind,
  }: {
    readonly cells: readonly TypedCell[];
    readonly kind: BranchKind;
  },
): Converted | null => {
  let years: ReadonlySet<string> = new Set(
    cells.map(({ academicYear }) => academicYear),
  );
  while (years.size > 0) {
    const outcome = trialOf(trial, mappings, { cells, kind, years });
    if (outcome === null) {
      return null;
    }
    if (outcome.changed.length === 0) {
      return mappingCount(outcome.converted.mappings) < mappingCount(mappings)
        ? outcome.converted
        : null;
    }
    years = withoutYears(years, outcome.changed);
  }
  return null;
};
