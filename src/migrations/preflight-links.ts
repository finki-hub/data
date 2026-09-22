import type { CheckpointRows } from './inventory.js';
import type { Indexes } from './preflight-indexes.js';
import type { Candidates, Finding } from './report.js';

import {
  finding,
  type LinkCandidate,
  listIds,
  nonEmpty,
  quote,
  resolveLabel,
} from './labels.js';
import { assignmentStaff, staffFindings } from './preflight-staff.js';

type Linked = {
  readonly findings: readonly Finding[];
  readonly link: LinkCandidate;
};

type OrphanCode = 'orphan_assignment' | 'orphan_equivalency' | 'orphan_pattern';

const orphanCodes: Readonly<Record<string, OrphanCode>> = {
  course_enrollment_patterns: 'orphan_pattern',
  course_equivalencies: 'orphan_equivalency',
  teaching_assignments: 'orphan_assignment',
};

// A label-based link to a course: more than one course of that name is an
// ambiguity the row actively depends on; none is an orphan row to review.
type LabelLink = {
  readonly collection: string;
  readonly id: number;
  readonly label: null | string;
};

const course = (
  { collection, id, label }: LabelLink,
  indexes: Indexes,
): Linked => {
  const link = resolveLabel(label, indexes.courses);
  if (link.resolution === 'unique') {
    return { findings: [], link };
  }
  if (link.resolution === 'ambiguous') {
    return {
      findings: [
        finding('ambiguous_course_name', {
          collection,
          ids: [id],
          label,
          message: `${quote(label)} names courses ${listIds(link.matches)}; the current derivation only ever matched by name, so the row cannot be linked until the courses are told apart.`,
        }),
      ],
      link,
    };
  }
  const named = label === null ? '' : ` (${quote(label)})`;
  return {
    findings: [
      finding(orphanCodes[collection] ?? 'orphan_equivalency', {
        collection,
        ids: [id],
        label,
        message: `${collection} row ${String(id)} names no existing course${named}; it is retained with its labels for review.`,
      }),
    ],
    link,
  };
};

const entry = (
  { id, label }: Omit<LabelLink, 'collection'>,
  indexes: Indexes,
  generation: '2018' | '2023',
): Linked => {
  const link = resolveLabel(
    label,
    generation === '2023' ? indexes.current : indexes.legacy,
  );
  const base = { collection: 'course_equivalencies', ids: [id], label };
  if (link.resolution === 'ambiguous') {
    return {
      findings: [
        finding('ambiguous_equivalency_entry', {
          ...base,
          message: `${quote(label)} matches curriculum_${generation} rows ${listIds(link.matches)}; the ${generation} entry link stays empty until resolved.`,
        }),
      ],
      link,
    };
  }
  if (link.resolution === 'missing') {
    return {
      findings: [
        finding('unmatched_equivalency_entry', {
          ...base,
          message: `${quote(label)} matches no curriculum_${generation} row; the label is retained without a ${generation} entry link.`,
        }),
      ],
      link,
    };
  }
  return { findings: [], link };
};

const equivalencies = (
  checkpoint: CheckpointRows,
  indexes: Indexes,
): {
  readonly candidates: Candidates['equivalencies'];
  readonly findings: readonly Finding[];
} => {
  const results = checkpoint.course_equivalencies.map((row) => {
    const linked = course(
      {
        collection: 'course_equivalencies',
        id: row.id,
        label: nonEmpty(row.course_2023),
      },
      indexes,
    );
    const entry2023 = entry(
      { id: row.id, label: nonEmpty(row.course_2023) },
      indexes,
      '2023',
    );
    const entry2018 = entry(
      { id: row.id, label: nonEmpty(row.course_2018) },
      indexes,
      '2018',
    );
    return {
      candidate: {
        course: linked.link,
        entry2018: entry2018.link,
        entry2023: entry2023.link,
        id: row.id,
      },
      findings: [
        ...linked.findings,
        ...entry2023.findings,
        ...entry2018.findings,
      ],
    };
  });
  return {
    candidates: results.map(({ candidate }) => candidate),
    findings: results.flatMap(({ findings }) => findings),
  };
};

// Every assignment row becomes (course, staff, role, display text) in the
// relational model, so each row's professor and assistant text is resolved
// here, duplicates and orphans included, and reported when it cannot be
// linked; the course-level candidate only records which row the derivation
// displayed.
const assignments = (
  checkpoint: CheckpointRows,
  indexes: Indexes,
): {
  readonly candidates: Candidates['assignments'];
  readonly findings: readonly Finding[];
} => {
  const results = checkpoint.teaching_assignments.map((row) => {
    const linked = course(
      {
        collection: 'teaching_assignments',
        id: row.id,
        label: nonEmpty(row.course_name),
      },
      indexes,
    );
    const staff = assignmentStaff(row, indexes.staff);
    return {
      candidate: { course: linked.link, id: row.id, staff },
      findings: [...linked.findings, ...staffFindings(row, staff)],
    };
  });
  return {
    candidates: results.map(({ candidate }) => candidate),
    findings: results.flatMap(({ findings }) => findings),
  };
};

export const linkedRows = { assignments, course, equivalencies };
