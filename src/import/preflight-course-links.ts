import type { CourseCandidate, LegacyCandidate } from './candidates.js';
import type { Indexes } from './preflight-indexes.js';
import type { CourseRow, EquivalencyRow } from './workbook-rows.js';

import { resolveCurriculum } from './curriculum-labels.js';
import { detailed, type Finding, finding, type PartRows } from './findings.js';
import { type LinkCandidate, nonEmpty, resolveLabel } from './labels.js';

export type Part<K extends keyof CourseCandidate> = {
  readonly findings: readonly Finding[];
  readonly value: CourseCandidate[K];
};

// Values of a generation the course has no name for: course_curricula,
// the only row that could hold them, gets none. Credits would disappear,
// so they block (the refusal line also names an availability of TRUE
// beside them). An availability alone is no value without a curriculum:
// the course links nothing of that generation, and TRUE, which the
// workbook states for a curriculum it does not name, is a rule fix
// (unlinked_availability, a warning). FALSE alone is no case.
const unlinkedValues = (
  course: CourseRow,
  generation: '2018' | '2023',
  link: LinkCandidate,
): readonly Finding[] => {
  if (link.resolution !== 'none') {
    return [];
  }
  const ids = [course.id];
  if (course[`credits_${generation}`] !== null) {
    return [
      detailed(finding('unlinked_generation_values', 'courses', ids), {
        generation,
      }),
    ];
  }
  return course[`available_${generation}`] === true
    ? [
        detailed(finding('unlinked_availability', 'courses', ids), {
          generation,
        }),
      ]
    : [];
};

export const currentOf = (
  course: CourseRow,
  indexes: Indexes,
): Part<'current'> => {
  const current = resolveCurriculum(
    nonEmpty(course.name_2023),
    indexes.current,
  );
  const findings: Finding[] = [...unlinkedValues(course, '2023', current)];
  if (current.resolution === 'ambiguous') {
    findings.push(
      detailed(finding('ambiguous_curriculum_2023', 'courses', [course.id]), {
        related: [{ collection: 'curriculum_2023', ids: current.matches }],
      }),
    );
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

// The equivalency rows of a course that carry a 2018 label.
const labelledRows = (
  rows: readonly EquivalencyRow[],
): readonly EquivalencyRow[] =>
  rows.filter((row) => nonEmpty(row.course_2018) !== null);

const distinctLabels = (rows: readonly EquivalencyRow[]): readonly string[] =>
  new Set(
    rows.flatMap((row) => {
      const value = nonEmpty(row.course_2018);
      return value === null ? [] : [value];
    }),
  )
    .values()
    .toArray();

// The equivalency row a 2018 name was taken from, when it was.
const sourceRows = ({
  equivalencies,
  source,
}: LegacyCandidate): readonly PartRows[] =>
  source === 'equivalency' && equivalencies.precedent !== null
    ? [{ collection: 'course_equivalencies', ids: [equivalencies.precedent] }]
    : [];

// An override naming no 2018 row, an equivalency label naming none (the
// name would be published without any entry), or a label naming several
// subjects.
const entryFindings = (
  course: CourseRow,
  legacy: LegacyCandidate,
): readonly Finding[] => {
  const { entry, source } = legacy;
  const ids = [course.id];
  const findings: Finding[] = [];
  if (source === 'override' && entry.resolution === 'missing') {
    findings.push(finding('missing_override_target', 'courses', ids));
  } else if (source === 'equivalency' && entry.resolution === 'missing') {
    findings.push(
      detailed(finding('unmatched_curriculum_2018_label', 'courses', ids), {
        related: sourceRows(legacy),
      }),
    );
  }
  if (source !== 'none' && entry.resolution === 'ambiguous') {
    findings.push(
      detailed(finding('ambiguous_curriculum_2018', 'courses', ids), {
        related: [
          { collection: 'curriculum_2018', ids: entry.matches },
          ...sourceRows(legacy),
        ],
      }),
    );
  }
  return findings;
};

const equivalencyFindings = (
  course: CourseRow,
  { equivalencies, source }: LegacyCandidate,
  rows: readonly EquivalencyRow[],
): readonly Finding[] => {
  const labels = distinctLabels(rows);
  if (source === 'equivalency' && labels.length > 1) {
    return [
      detailed(
        finding('ambiguous_legacy_equivalency', 'courses', [course.id]),
        {
          related: [
            {
              collection: 'course_equivalencies',
              ids: labelledRows(rows).map(({ id }) => id),
            },
          ],
        },
      ),
    ];
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
// first equivalency row of the course name, each looked up among the 2018
// curriculum rows (several listings of one subject link the first).
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
    entry: resolveCurriculum(label, indexes.legacy),
    equivalencies,
    source: legacySource(override, equivalencyLabel),
  };
  return {
    findings: [
      ...unlinkedValues(course, '2018', legacy.entry),
      ...entryFindings(course, legacy),
      ...equivalencyFindings(course, legacy, rows),
    ],
    value: legacy,
  };
};
