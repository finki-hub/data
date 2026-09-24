import type { Candidates } from './report.js';

import {
  Collector,
  type Conversion,
  existing,
  pending,
  unresolved,
} from './converter-types.js';
import { finding, type LinkCandidate, listIds, quote } from './labels.js';

// A patch of the course link of one equivalency row. Its labels are never
// touched; its members are rows of their own (equivalency-members.ts).
export type EquivalencyLinkRecord = {
  readonly course: number;
  readonly id: number;
};

type Row = Candidates['equivalencies'][number];

const collection = 'course_equivalencies';

export type EquivalencyInput = {
  readonly candidates: Candidates['equivalencies'];
  // The course link as each row carries it now: a link already set is
  // skipped and a link set by hand is never overwritten.
  readonly current: ReadonlyMap<number, null | number>;
};

const courseFinding = (id: number, link: LinkCandidate) =>
  link.resolution === 'ambiguous'
    ? finding('ambiguous_course_name', {
        collection,
        ids: [id],
        label: link.label,
        message: `${quote(link.label)} names courses ${listIds(link.matches)}; equivalency row ${String(id)} keeps its labels and no course link until the courses are told apart.`,
      })
    : finding('orphan_equivalency', {
        collection,
        ids: [id],
        label: link.label,
        message: `equivalency row ${String(id)} names no existing course (${quote(link.label)}); it is retained with its labels for review.`,
      });

const convertRow = (
  out: Collector<EquivalencyLinkRecord>,
  input: EquivalencyInput,
  row: Row,
): void => {
  const link = row.course;
  const source = { collection, id: row.id, relation: 'course' };
  const current = input.current.get(row.id) ?? null;
  const target = link.resolution === 'unique' ? link.precedent : null;
  if (current !== null) {
    if (target !== null && target !== current) {
      out.find(
        finding('manual_link_retained', {
          collection,
          ids: [row.id],
          label: link.label,
          message: `equivalency row ${String(row.id)} already links course ${String(current)} while its label names ${String(target)}; the link set by hand is retained.`,
        }),
      );
    }
    out.settle(existing(source, 'courses', current));
    return;
  }
  if (target !== null) {
    out.write({ course: target, id: row.id }, [
      pending(source, 'courses', target),
    ]);
    return;
  }
  out.find(courseFinding(row.id, link));
  out.settle(unresolved(source, 'courses'));
};

// Sets the course link when the 2023 label names exactly one course; a
// row it cannot resolve is retained and reported. Every label stays as it
// is.
export const convertEquivalencyLinks = (
  input: EquivalencyInput,
): Conversion<EquivalencyLinkRecord> => {
  const out = new Collector<EquivalencyLinkRecord>();
  for (const row of input.candidates) {
    convertRow(out, input, row);
  }
  return out.result();
};
