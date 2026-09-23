import type { Inventory } from './inventory.js';
import type { LinkCandidate } from './labels.js';
import type { RowCandidates } from './preflight-rows.js';
import type { CourseCandidate } from './report.js';

import { type Existing, existingTargets, key } from './preflight-existing.js';
import { mergeSourceMap, type SourceMapEntry } from './source-map.js';

type Source = {
  readonly collection: string;
  readonly id: number | string;
  readonly relation: string;
};

const rowEntry = (
  source: Source,
  targetCollection: string,
  existingId: number | undefined,
): SourceMapEntry => ({
  relation: source.relation,
  sourceCollection: source.collection,
  sourceId: source.id,
  status: existingId === undefined ? 'pending' : 'existing',
  targetCollection,
  targetId: existingId ?? null,
});

type LinkTarget = {
  readonly existingId?: number | undefined;
  readonly precedentIsTarget: boolean;
};

// A label link: pending with its target when unique, unresolved when the
// label is ambiguous or missing, absent when the source has no label. The
// precedent is the target only when the link points at an existing row;
// a link whose target row the converter creates carries the existing id or
// nothing.
type Link = {
  readonly link: LinkCandidate;
  readonly source: Source;
  readonly target: LinkTarget;
  readonly targetCollection: string;
};

const linkEntry = ({
  link,
  source,
  target,
  targetCollection,
}: Link): readonly SourceMapEntry[] => {
  if (link.resolution === 'none') {
    return [];
  }
  if (link.resolution !== 'unique') {
    return [
      {
        ...rowEntry(source, targetCollection, undefined),
        status: 'unresolved',
      },
    ];
  }
  const { existingId } = target;
  return [
    {
      ...rowEntry(source, targetCollection, existingId),
      targetId:
        existingId ?? (target.precedentIsTarget ? link.precedent : null),
    },
  ];
};

const toExistingRow: LinkTarget = { precedentIsTarget: true };

const entryFor = (
  existing: Existing,
  collection: 'curriculum_2018' | 'curriculum_2023',
  link: LinkCandidate,
): LinkTarget => ({
  existingId:
    link.resolution === 'unique' && link.precedent !== null
      ? existing.entries.get(key(collection, link.precedent))
      : undefined,
  precedentIsTarget: false,
});

const courseEntries = (
  course: CourseCandidate,
  existing: Existing,
): readonly SourceMapEntry[] => {
  const source = (relation: string): Source => ({
    collection: 'courses',
    id: course.id,
    relation,
  });
  const linkTarget = (generation: string): LinkTarget => ({
    existingId: existing.links.get(key(course.id, generation)),
    precedentIsTarget: false,
  });
  return [
    ...linkEntry({
      link: course.current,
      source: source('curriculum_2023'),
      target: linkTarget('2023'),
      targetCollection: 'course_curricula',
    }),
    ...linkEntry({
      link: course.legacy.entry,
      source: source('curriculum_2018'),
      target: linkTarget('2018'),
      targetCollection: 'course_curricula',
    }),
    ...course.rules.map((rule) =>
      rowEntry(
        source(`rule:${rule.academicYear}`),
        'course_enrollment_rules',
        existing.rules.get(key(course.id, rule.academicYear)),
      ),
    ),
  ];
};

const equivalencyEntries = (
  row: RowCandidates['equivalencies'][number],
  existing: Existing,
): readonly SourceMapEntry[] => {
  const source = (relation: string): Source => ({
    collection: 'course_equivalencies',
    id: row.id,
    relation,
  });
  return [
    ...linkEntry({
      link: row.course,
      source: source('course'),
      target: toExistingRow,
      targetCollection: 'courses',
    }),
    ...linkEntry({
      link: row.entry2023,
      source: source('entry_2023'),
      target: entryFor(existing, 'curriculum_2023', row.entry2023),
      targetCollection: 'curriculum_entries',
    }),
    ...linkEntry({
      link: row.entry2018,
      source: source('entry_2018'),
      target: entryFor(existing, 'curriculum_2018', row.entry2018),
      targetCollection: 'curriculum_entries',
    }),
  ];
};

// The source-to-target id map skeleton: every row the converters will create
// or link, marked existing where a target row already carries provenance.
export const buildMappings = (
  inventory: Inventory,
  {
    academicYears,
    courses,
    rows,
  }: {
    readonly academicYears: readonly string[];
    readonly courses: readonly CourseCandidate[];
    readonly rows: RowCandidates;
  },
): readonly SourceMapEntry[] => {
  const existing = existingTargets(inventory.targets);
  const entryRows = (collection: 'curriculum_2018' | 'curriculum_2023') =>
    inventory.checkpoint[collection].map((row) =>
      rowEntry(
        { collection, id: row.id, relation: 'entry' },
        'curriculum_entries',
        existing.entries.get(key(collection, row.id)),
      ),
    );
  return mergeSourceMap([
    ...entryRows('curriculum_2023'),
    ...entryRows('curriculum_2018'),
    ...academicYears.map((label) =>
      rowEntry(
        { collection: 'academic_years', id: label, relation: 'label' },
        'academic_years',
        existing.years.get(label),
      ),
    ),
    ...courses.flatMap((course) => courseEntries(course, existing)),
    ...rows.council.flatMap((member) =>
      linkEntry({
        link: member.student,
        source: {
          collection: 'student_council',
          id: member.id,
          relation: 'student',
        },
        target: toExistingRow,
        targetCollection: 'students',
      }),
    ),
    ...rows.assignments.flatMap((row) =>
      linkEntry({
        link: row.course,
        source: {
          collection: 'teaching_assignments',
          id: row.id,
          relation: 'course',
        },
        target: toExistingRow,
        targetCollection: 'courses',
      }),
    ),
    ...rows.patterns.flatMap((row) =>
      linkEntry({
        link: row.course,
        source: {
          collection: 'course_enrollment_patterns',
          id: row.id,
          relation: 'course',
        },
        target: toExistingRow,
        targetCollection: 'courses',
      }),
    ),
    ...rows.equivalencies.flatMap((row) => equivalencyEntries(row, existing)),
  ]);
};
