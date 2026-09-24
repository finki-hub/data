import type { EntrySource } from './generations.js';
import type { CourseRow } from './inventory-schemas.js';
import type { CourseCandidate } from './report.js';

import {
  Collector,
  compositeKey,
  type Conversion,
  ConverterError,
  existing,
  pending,
  unresolved,
} from './converter-types.js';
import { entryKey, type GenerationIds } from './curricula.js';
import { finding, type LinkCandidate, listIds, quote } from './labels.js';

// The course_curricula link of one course and generation (its row id):
// credits and availability come from the course columns of that
// generation.
export type CourseLinkRecord = {
  readonly available: boolean | null;
  readonly course: number;
  readonly credits: null | number;
  readonly entry: number;
  readonly generation: number;
  readonly sort: number;
};

// A link already present for a course and generation, with the entry it
// points at.
export type ExistingLink = {
  readonly entry: null | number;
  readonly id: number;
};

export const linkKey = (course: number | string, generation: number | string) =>
  compositeKey(course, generation);

const linkCollection = 'course_curricula';

// The import columns of a workbook generation (its code) on courses.
type GenerationSpec = {
  readonly collection: EntrySource;
  readonly generation: '2018' | '2023';
  readonly link: (candidate: CourseCandidate) => LinkCandidate;
  readonly sort: number;
  readonly values: (
    row: CourseRow,
  ) => Pick<CourseLinkRecord, 'available' | 'credits'>;
};

const generationSpecs: readonly GenerationSpec[] = [
  {
    collection: 'curriculum_2023',
    generation: '2023',
    link: (candidate) => candidate.current,
    sort: 1,
    values: (row) => ({
      available: row.available_2023,
      credits: row.credits_2023,
    }),
  },
  {
    collection: 'curriculum_2018',
    generation: '2018',
    link: (candidate) => candidate.legacy.entry,
    sort: 2,
    values: (row) => ({
      available: row.available_2018,
      credits: row.credits_2018,
    }),
  },
];

export type CourseLinkInput = {
  readonly candidates: readonly CourseCandidate[];
  readonly courses: readonly CourseRow[];
  readonly entryIds: ReadonlyMap<string, number>;
  // Links keyed by course and generation id.
  readonly existing: ReadonlyMap<string, ExistingLink>;
  readonly generationIds: GenerationIds;
};

const generationIdOf = (input: CourseLinkInput, spec: GenerationSpec) => {
  const id = input.generationIds.get(spec.generation);
  if (id === undefined) {
    throw new ConverterError(
      `The generation ${spec.generation} was not created before its course links.`,
    );
  }
  return id;
};

type Target = {
  readonly candidate: CourseCandidate;
  readonly row: CourseRow;
  readonly spec: GenerationSpec;
};

const sourceOf = ({ candidate, spec }: Target) => ({
  collection: 'courses',
  id: candidate.id,
  relation: spec.collection,
});

const unresolvedLink = (
  out: Collector<CourseLinkRecord>,
  target: Target,
): void => {
  const { candidate, spec } = target;
  const link = spec.link(candidate);
  const base = {
    collection: 'courses',
    ids: [candidate.id],
    label: link.label,
  };
  out.find(
    link.resolution === 'ambiguous'
      ? finding(`ambiguous_curriculum_${spec.generation}`, {
          ...base,
          message: `${quote(link.label)} of course ${String(candidate.id)} names ${spec.collection} rows ${listIds(link.matches)}; no ${spec.generation} link is set until the entry is chosen explicitly.`,
        })
      : finding(`unmatched_curriculum_${spec.generation}_label`, {
          ...base,
          message: `${quote(link.label)} of course ${String(candidate.id)} names no ${spec.collection} row; the label is retained on the course and no ${spec.generation} link is set.`,
        }),
  );
  out.settle(unresolved(sourceOf(target), linkCollection));
};

// A generation without a label still carries credits or availability on
// the course: course_curricula is the only target for those values, so
// they are retained on the course and put under review, never dropped
// silently.
const unlinkedValues = (
  out: Collector<CourseLinkRecord>,
  target: Target,
): void => {
  const { candidate, row, spec } = target;
  const { available, credits } = spec.values(row);
  if (available === null && credits === null) {
    return;
  }
  out.find(
    finding('unlinked_generation_values', {
      collection: 'courses',
      ids: [candidate.id],
      label: candidate.name,
      message: `course ${String(candidate.id)} carries credits_${spec.generation} ${String(credits)} and available_${spec.generation} ${String(available)} but no ${spec.generation} label, so no ${spec.generation} link holds them; the values are retained on the course for review.`,
    }),
  );
  out.settle(unresolved(sourceOf(target), linkCollection));
};

const linkOf = (
  input: CourseLinkInput,
  { candidate, row, spec }: Target,
): CourseLinkRecord => {
  const link = spec.link(candidate);
  const entry =
    link.precedent === null
      ? undefined
      : input.entryIds.get(entryKey(spec.collection, link.precedent));
  if (entry === undefined) {
    throw new ConverterError(
      `The ${spec.collection} entry ${String(link.precedent)} linked by course ${String(candidate.id)} was not created before its link; the curricula step must create every entry first.`,
    );
  }
  return {
    ...spec.values(row),
    course: candidate.id,
    entry,
    generation: generationIdOf(input, spec),
    sort: spec.sort,
  };
};

// A link already present is reused; one pointing at another entry than the
// candidate names was set by hand and is retained and reported, never
// overwritten or adopted silently.
const reuseLink = (
  out: Collector<CourseLinkRecord>,
  target: Target,
  { link, present }: { link: CourseLinkRecord; present: ExistingLink },
): void => {
  const { candidate, spec } = target;
  if (present.entry !== link.entry) {
    out.find(
      finding('manual_link_retained', {
        collection: linkCollection,
        ids: [present.id],
        label: spec.link(candidate).label,
        message: `course_curricula row ${String(present.id)} already links course ${String(candidate.id)} to ${spec.generation} entry ${String(present.entry)} while its label names entry ${String(link.entry)}; the link set by hand is retained.`,
      }),
    );
  }
  out.settle(existing(sourceOf(target), linkCollection, present.id));
};

const linkGeneration = (
  out: Collector<CourseLinkRecord>,
  input: CourseLinkInput,
  target: Target,
): void => {
  const { candidate, spec } = target;
  const link = spec.link(candidate);
  if (link.resolution === 'none') {
    unlinkedValues(out, target);
    return;
  }
  if (link.resolution !== 'unique') {
    unresolvedLink(out, target);
    return;
  }
  const planned = linkOf(input, target);
  const present = input.existing.get(linkKey(candidate.id, planned.generation));
  if (present === undefined) {
    out.write(planned, [pending(sourceOf(target), linkCollection)]);
  } else {
    reuseLink(out, target, { link: planned, present });
  }
};

// One link per course and generation whose candidate is unique: the 2023
// entry by name_2023 and the 2018 entry by override or first equivalency,
// exactly the rows the checkpoint derivation copied. Ambiguous and missing
// labels are reported and left unlinked; a course without a label for a
// generation keeps no link, and needs review only when the course still
// carries credits or availability for that generation.
export const convertCourseCurricula = (
  input: CourseLinkInput,
): Conversion<CourseLinkRecord> => {
  const out = new Collector<CourseLinkRecord>();
  for (const candidate of input.candidates) {
    const row = input.courses.find((course) => course.id === candidate.id);
    if (row === undefined) {
      throw new ConverterError(
        `Course candidate ${String(candidate.id)} has no checkpoint row.`,
      );
    }
    for (const spec of generationSpecs) {
      linkGeneration(out, input, { candidate, row, spec });
    }
  }
  return out.result();
};
