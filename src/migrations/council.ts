import type { Candidates } from './report.js';

import {
  Collector,
  type Conversion,
  existing,
  pending,
  unresolved,
} from './converter-types.js';
import { finding, listIds, quote } from './labels.js';

export type CouncilLinkRecord = {
  readonly id: number;
  readonly student: number;
};

type Member = Candidates['council'][number];

const collection = 'student_council';

export type CouncilInput = {
  readonly candidates: Candidates['council'];
  // The `student` column as the rows carry it now, so a link already set
  // is skipped and a link set by hand is never overwritten.
  readonly current: ReadonlyMap<number, null | number>;
};

const manualFinding = (member: Member, current: number, target: number) =>
  finding('manual_link_retained', {
    collection,
    ids: [member.id],
    label: member.indexNumber,
    message: `council row ${String(member.id)} already links student ${String(current)} while index ${quote(member.indexNumber)} names student ${String(target)}; the link set by hand is retained.`,
  });

const unresolvedFinding = (member: Member) => {
  const base = { collection, ids: [member.id], label: member.indexNumber };
  if (member.student.resolution === 'ambiguous') {
    return finding('ambiguous_student_index', {
      ...base,
      message: `index ${quote(member.indexNumber)} matches student rows ${listIds(member.student.matches)}; the student link stays empty and every student row is retained.`,
    });
  }
  if (member.indexNumber === null) {
    return finding('invalid_source_row', {
      ...base,
      message: `council row ${String(member.id)} has no index number; it is retained and links no student.`,
    });
  }
  return finding('unmatched_council_index', {
    ...base,
    message: `council row ${String(member.id)} carries index ${quote(member.indexNumber)}, which matches no student row; it keeps its copied name and index for review.`,
  });
};

// Links a member only when exactly one student row carries the index; an
// ambiguous or unmatched index keeps the copied name and index for review.
export const convertCouncilLinks = (
  input: CouncilInput,
): Conversion<CouncilLinkRecord> => {
  const out = new Collector<CouncilLinkRecord>();
  for (const member of input.candidates) {
    const source = { collection, id: member.id, relation: 'student' };
    const current = input.current.get(member.id) ?? null;
    const target =
      member.student.resolution === 'unique' ? member.student.precedent : null;
    if (current !== null) {
      if (target !== null && target !== current) {
        out.find(manualFinding(member, current, target));
      }
      out.settle(existing(source, 'students', current));
    } else if (target === null) {
      out.find(unresolvedFinding(member));
      out.settle(unresolved(source, 'students'));
    } else {
      out.write({ id: member.id, student: target }, [
        pending(source, 'students', target),
      ]);
    }
  }
  return out.result();
};
