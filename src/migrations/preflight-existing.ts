import type { TargetRows } from './inventory.js';

export type Existing = {
  readonly entries: ReadonlyMap<string, number>;
  readonly links: ReadonlyMap<string, number>;
  readonly rules: ReadonlyMap<string, number>;
  readonly years: ReadonlyMap<string, number>;
};

export const key = (left: number | string, right: number | string): string =>
  `${String(left)}\u{0}${String(right)}`;

const existingYears = (targets: TargetRows): ReadonlyMap<string, number> =>
  new Map(
    targets.academic_years.flatMap((row) =>
      row.label === null ? [] : [[row.label, row.id]],
    ),
  );

const existingRules = (
  targets: TargetRows,
  years: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> => {
  const labels = new Map(years.entries().map(([label, id]) => [id, label]));
  return new Map(
    targets.course_enrollment_rules.flatMap((row) => {
      const label =
        row.academic_year === null ? undefined : labels.get(row.academic_year);
      return row.course === null || label === undefined
        ? []
        : [[key(row.course, label), row.id]];
    }),
  );
};

// Links keyed by course and generation code (a link carries the id of
// its generation row).
const existingLinks = (targets: TargetRows): ReadonlyMap<string, number> => {
  const codes = new Map(
    targets.curriculum_generations.map(({ code, id }) => [id, code]),
  );
  return new Map(
    targets.course_curricula.flatMap((row) => {
      const code =
        row.generation === null ? undefined : codes.get(row.generation);
      return row.course === null || code === undefined || code === null
        ? []
        : [[key(row.course, code), row.id]];
    }),
  );
};

// Target rows an earlier run already wrote, keyed by their provenance.
export const existingTargets = (targets: null | TargetRows): Existing => {
  if (targets === null) {
    return {
      entries: new Map(),
      links: new Map(),
      rules: new Map(),
      years: new Map(),
    };
  }
  const years = existingYears(targets);
  return {
    entries: new Map(
      targets.curriculum_entries.flatMap((row) =>
        row.source_collection === null || row.source_id === null
          ? []
          : [[key(row.source_collection, row.source_id), row.id]],
      ),
    ),
    links: existingLinks(targets),
    rules: existingRules(targets, years),
    years,
  };
};
