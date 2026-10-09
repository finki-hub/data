import type { CourseMappings } from './pattern-join.js';

import {
  designLines,
  type LineSets,
  type PatternCourse,
  type TypedCell,
} from './pattern-proof.js';
import {
  branchesOf,
  type BranchKind,
  templateOf,
} from './pattern-templates.js';
import {
  branchYear,
  keyOf,
  startYear,
  type Trial,
  tryCells,
} from './pattern-trial.js';

// The conversion of one course's kept typed cells into all-years mappings
// (plan step 13): groups of cells with one template, tried in two passes;
// each conversion must pass its trial (pattern-trial.ts).

// One accepted conversion: its pass, its kind, the cells it converted and
// the size of the group it started from.
export type Conversion = {
  readonly cells: readonly TypedCell[];
  readonly group: number;
  readonly kind: BranchKind;
  readonly pass: 1 | 2;
};

const collator = new Intl.Collator('en');

type MergeState = {
  conversions: Conversion[];
  mappings: CourseMappings;
};

// Tries one group with each kind in turn and keeps the first conversion.
const convertGroup = (
  trial: Trial,
  state: MergeState,
  {
    cells,
    kinds,
    pass,
  }: {
    readonly cells: readonly TypedCell[];
    readonly kinds: readonly BranchKind[];
    readonly pass: 1 | 2;
  },
): boolean => {
  for (const kind of kinds) {
    const result = tryCells(trial, state.mappings, { cells, kind });
    if (result !== null) {
      state.mappings = result.mappings;
      state.conversions.push({
        cells: result.cells,
        group: cells.length,
        kind,
        pass,
      });
      return true;
    }
  }
  return false;
};

const yearRank = (sets: LineSets, cells: readonly TypedCell[]): number =>
  sets.years.indexOf(cells[0]?.academicYear ?? '');

// Pass 1: the groups of cells with one template, largest first, then the
// group with the latest year; every group tries kind A, then the groups
// not converted try kind B.
const firstPass = (
  trial: Trial,
  state: MergeState,
  kept: readonly TypedCell[],
) => {
  const groups = Map.groupBy(kept, ({ academicYear, pattern }) =>
    templateOf(pattern, startYear(academicYear)),
  )
    .values()
    .toArray()
    .toSorted(
      (left, right) =>
        right.length - left.length ||
        yearRank(trial.sets, left) - yearRank(trial.sets, right),
    );
  const converted = new Set(
    groups.filter((cells) =>
      convertGroup(trial, state, { cells, kinds: ['A'], pass: 1 }),
    ),
  );
  const unconverted = groups.filter((group) => !converted.has(group));
  for (const cells of unconverted) {
    convertGroup(trial, state, { cells, kinds: ['B'], pass: 1 });
  }
};

// The year patterns a cell's branches need that the course has no
// all-years mapping for yet, as one key; null when a branch has none.
const neededKey = (trial: Trial, state: MergeState, cell: TypedCell) => {
  const start = startYear(cell.academicYear);
  const needed = new Set<string>();
  for (const branch of branchesOf(cell.pattern)) {
    const yearPattern = branchYear(trial.sets, branch, start);
    if (yearPattern === null) {
      return null;
    }
    if (!state.mappings.allYears.has(yearPattern)) {
      needed.add(yearPattern);
    }
  }
  return needed.size === 0
    ? null
    : [...needed]
        .toSorted((left, right) => collator.compare(left, right))
        .join('\n');
};

// Pass 2: the cells still only-in-year, grouped by the year patterns they
// need that the course has none of; groups of two or more try kind A,
// then B, largest first, until nothing converts.
const secondPass = (
  trial: Trial,
  state: MergeState,
  kept: readonly TypedCell[],
) => {
  let converting = true;
  while (converting) {
    const remaining = kept.filter(({ academicYear }) =>
      state.mappings.onlyInYear.has(academicYear),
    );
    const groups = [
      ...Map.groupBy(remaining, (cell) => neededKey(trial, state, cell)),
    ]
      .filter(([key, cells]) => key !== null && cells.length >= 2)
      .map(([, cells]) => cells)
      .toSorted((left, right) => right.length - left.length);
    converting = groups.some((cells) =>
      convertGroup(trial, state, { cells, kinds: ['A', 'B'], pass: 2 }),
    );
  }
};

// The mappings of one course after the conversion of its kept cells, which
// start as only-in-year mappings beside its standard all-years mapping,
// and the conversions accepted.
export const mergeCourse = (
  sets: LineSets,
  course: PatternCourse,
  {
    kept,
    standard,
  }: { readonly kept: readonly TypedCell[]; readonly standard: CourseMappings },
): {
  readonly conversions: readonly Conversion[];
  readonly mappings: CourseMappings;
} => {
  const trial: Trial = {
    course,
    design: new Map(
      sets.years.map((year) => [year, keyOf(designLines(sets, course, year))]),
    ),
    sets,
  };
  const state: MergeState = { conversions: [], mappings: standard };
  firstPass(trial, state, kept);
  secondPass(trial, state, kept);
  return state;
};
