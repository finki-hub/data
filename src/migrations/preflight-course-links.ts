import type { CourseRow, EquivalencyRow } from './inventory-schemas.js';
import type { Indexes } from './preflight-indexes.js';
import type { CourseCandidate, Finding } from './report.js';

import {
  finding,
  type LinkCandidate,
  listIds,
  nonEmpty,
  quote,
  resolveLabel,
} from './labels.js';

export type Part<K extends keyof CourseCandidate> = {
  readonly findings: readonly Finding[];
  readonly value: CourseCandidate[K];
};

const forCourse = (course: CourseRow, label: null | string) => ({
  collection: 'courses',
  ids: [course.id],
  label,
});

export const currentOf = (
  course: CourseRow,
  indexes: Indexes,
): Part<'current'> => {
  const current = resolveLabel(nonEmpty(course.name_2023), indexes.current);
  const findings: Finding[] = [];
  if (current.resolution === 'ambiguous') {
    findings.push(
      finding('ambiguous_curriculum_2023', {
        ...forCourse(course, current.label),
        message: `name_2023 ${quote(current.label)} matches curriculum_2023 rows ${listIds(current.matches)}; the current derivation copies the first ascending id ${String(current.precedent)}. Choose the 2023 entry explicitly before cutover.`,
      }),
    );
  } else if (current.resolution === 'missing') {
    findings.push(
      finding('unmatched_curriculum_2023_label', {
        ...forCourse(course, current.label),
        message: `name_2023 ${quote(current.label)} matches no curriculum_2023 row; the label is retained and the course keeps no 2023 entry (no fallback to the canonical name).`,
      }),
    );
  }
  return { findings, value: current };
};

type Legacy = CourseCandidate['legacy'];

const legacySource = (
  override: null | string,
  equivalencyLabel: null | string,
): Legacy['source'] => {
  if (override !== null) {
    return 'override';
  }
  return equivalencyLabel === null ? 'none' : 'equivalency';
};

const distinctLabels = (rows: readonly EquivalencyRow[]): readonly string[] =>
  new Set(
    rows.flatMap((row) => {
      const value = nonEmpty(row.course_2018);
      return value === null ? [] : [value];
    }),
  )
    .values()
    .toArray();

const entryFindings = (
  course: CourseRow,
  name: string,
  legacy: Legacy,
): readonly Finding[] => {
  const { entry, label, source } = legacy;
  const findings: Finding[] = [];
  if (source === 'override' && entry.resolution === 'missing') {
    findings.push(
      finding('missing_override_target', {
        ...forCourse(course, label),
        message: `name_2018_override ${quote(label)} names no curriculum_2018 row; fix the override or add the row before cutover.`,
      }),
    );
  } else if (source === 'equivalency' && entry.resolution === 'missing') {
    findings.push(
      finding('unmatched_curriculum_2018_label', {
        ...forCourse(course, label),
        message: `equivalency label ${quote(label)} of ${quote(name)} matches no curriculum_2018 row; the label is retained and the course keeps no 2018 entry.`,
      }),
    );
  }
  if (source !== 'none' && entry.resolution === 'ambiguous') {
    findings.push(
      finding('ambiguous_curriculum_2018', {
        ...forCourse(course, label),
        message: `legacy label ${quote(label)} matches curriculum_2018 rows ${listIds(entry.matches)}; the current derivation copies the first ascending id ${String(entry.precedent)}. Choose the 2018 entry explicitly before cutover.`,
      }),
    );
  }
  return findings;
};

const equivalencyFindings = (
  course: CourseRow,
  name: string,
  legacy: Legacy & { readonly labels: readonly string[] },
): readonly Finding[] => {
  const { equivalencies, labels, source } = legacy;
  const listed = labels.map((value) => quote(value)).join(', ');
  if (source === 'equivalency' && labels.length > 1) {
    return [
      finding('ambiguous_legacy_equivalency', {
        ...forCourse(course, name),
        message: `equivalency rows ${listIds(equivalencies.matches)} carry different 2018 labels (${listed}); the current derivation uses the first ascending id ${String(equivalencies.precedent)}. Choose the legacy label explicitly before cutover.`,
      }),
    ];
  }
  if (source === 'equivalency' && equivalencies.matches.length > 1) {
    return [
      finding('duplicate_equivalency', {
        collection: 'course_equivalencies',
        ids: equivalencies.matches,
        label: name,
        message: `equivalency rows ${listIds(equivalencies.matches)} repeat the same labels for ${quote(name)}; all are retained, the first ascending id ${String(equivalencies.precedent)} is the precedent.`,
      }),
    ];
  }
  if (source === 'none' && labels.length > 0) {
    return [
      finding('equivalency_label_after_precedent', {
        ...forCourse(course, name),
        message: `the first equivalency row ${String(equivalencies.precedent)} for ${quote(name)} has no 2018 label, so the current derivation resolves none although later rows carry ${listed}.`,
      }),
    ];
  }
  return [];
};

// The legacy entry: name_2018_override first, else the 2018 label of the
// first equivalency row of the canonical name, looked up by first ascending
// id, exactly as the checkpoint derivation does.
export const legacyOf = (
  course: CourseRow,
  name: string,
  indexes: Indexes,
): Part<'legacy'> => {
  const equivalencies: LinkCandidate = resolveLabel(
    nonEmpty(name),
    indexes.equivalencies,
  );
  const rows = equivalencies.matches.flatMap((id) => {
    const row = indexes.equivalencyRows.get(id);
    return row === undefined ? [] : [row];
  });
  const equivalencyLabel = nonEmpty(rows[0]?.course_2018);
  const override = nonEmpty(course.name_2018_override);
  const label = override ?? equivalencyLabel;
  const legacy: Legacy = {
    entry: resolveLabel(label, indexes.legacy),
    equivalencies,
    label,
    source: legacySource(override, equivalencyLabel),
  };
  return {
    findings: [
      ...entryFindings(course, name, legacy),
      ...equivalencyFindings(course, name, {
        ...legacy,
        labels: distinctLabels(rows),
      }),
    ],
    value: legacy,
  };
};
