import type { CourseCandidate, LegacyCandidate } from './candidates.js';
import type { Indexes } from './preflight-indexes.js';
import type { CourseRow, EquivalencyRow } from './workbook-rows.js';

import { type Finding, finding } from './findings.js';
import { type LinkCandidate, nonEmpty, resolveLabel } from './labels.js';

export type Part<K extends keyof CourseCandidate> = {
  readonly findings: readonly Finding[];
  readonly value: CourseCandidate[K];
};

// Credits or availability of a generation the course has no label for:
// course_curricula, the only row that could hold them, gets none, so the
// published values would disappear.
const unlinkedValues = (
  course: CourseRow,
  generation: '2018' | '2023',
  link: LinkCandidate,
): readonly Finding[] => {
  const credits = course[`credits_${generation}`];
  const available = course[`available_${generation}`];
  return link.resolution === 'none' && (credits !== null || available !== null)
    ? [finding('unlinked_generation_values', 'courses', [course.id])]
    : [];
};

export const currentOf = (
  course: CourseRow,
  indexes: Indexes,
): Part<'current'> => {
  const current = resolveLabel(nonEmpty(course.name_2023), indexes.current);
  const findings: Finding[] = [...unlinkedValues(course, '2023', current)];
  if (current.resolution === 'ambiguous') {
    findings.push(finding('ambiguous_curriculum_2023', 'courses', [course.id]));
  } else if (current.resolution === 'missing') {
    findings.push(
      finding('unmatched_curriculum_2023_label', 'courses', [course.id]),
    );
  }
  return { findings, value: current };
};

const legacySource = (
  override: null | string,
  equivalencyLabel: null | string,
): LegacyCandidate['source'] => {
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

// An override naming no 2018 row, an equivalency label naming none (the
// name would be published without any entry), or a label naming several.
const entryFindings = (
  course: CourseRow,
  { entry, source }: LegacyCandidate,
): readonly Finding[] => {
  const ids = [course.id];
  const findings: Finding[] = [];
  if (source === 'override' && entry.resolution === 'missing') {
    findings.push(finding('missing_override_target', 'courses', ids));
  } else if (source === 'equivalency' && entry.resolution === 'missing') {
    findings.push(finding('unmatched_curriculum_2018_label', 'courses', ids));
  }
  if (source !== 'none' && entry.resolution === 'ambiguous') {
    findings.push(finding('ambiguous_curriculum_2018', 'courses', ids));
  }
  return findings;
};

const equivalencyFindings = (
  course: CourseRow,
  legacy: LegacyCandidate & { readonly labels: readonly string[] },
): readonly Finding[] => {
  const { equivalencies, labels, source } = legacy;
  if (source === 'equivalency' && labels.length > 1) {
    return [finding('ambiguous_legacy_equivalency', 'courses', [course.id])];
  }
  if (source === 'equivalency' && equivalencies.matches.length > 1) {
    return [
      finding(
        'duplicate_equivalency',
        'course_equivalencies',
        equivalencies.matches,
      ),
    ];
  }
  if (source === 'none' && labels.length > 0) {
    return [
      finding('equivalency_label_after_precedent', 'courses', [course.id]),
    ];
  }
  return [];
};

// The 2018 entry: name_2018_override first, else the 2018 label of the
// first equivalency row of the course name, each looked up by the first
// matching row.
export const legacyOf = (
  course: CourseRow,
  name: string,
  indexes: Indexes,
): Part<'legacy'> => {
  const equivalencies = resolveLabel(nonEmpty(name), indexes.equivalencies);
  const rows = equivalencies.matches.flatMap((id) => {
    const row = indexes.equivalencyRows.get(id);
    return row === undefined ? [] : [row];
  });
  const equivalencyLabel = nonEmpty(rows[0]?.course_2018);
  const override = nonEmpty(course.name_2018_override);
  const label = override ?? equivalencyLabel;
  const legacy: LegacyCandidate = {
    entry: resolveLabel(label, indexes.legacy),
    equivalencies,
    source: legacySource(override, equivalencyLabel),
  };
  return {
    findings: [
      ...unlinkedValues(course, '2018', legacy.entry),
      ...entryFindings(course, legacy),
      ...equivalencyFindings(course, {
        ...legacy,
        labels: distinctLabels(rows),
      }),
    ],
    value: legacy,
  };
};
