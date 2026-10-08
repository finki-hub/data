import type { Candidates } from './candidates.js';
import type { WorkbookRows } from './workbook-rows.js';

import { resolveCurriculum } from './curriculum-labels.js';
import {
  detailed,
  type Finding,
  finding,
  type FindingCode,
} from './findings.js';
import { type LinkCandidate, nonEmpty, resolveLabel } from './labels.js';
import { type Indexes, usedAssignment } from './preflight-indexes.js';
import { assignmentStaff, staffFindings } from './preflight-staff.js';

type Linked = {
  readonly findings: readonly Finding[];
  readonly link: LinkCandidate;
};

// A label-based link to a course: more than one course of that name is an
// ambiguity the row depends on; none is an orphan, whose code the caller
// names (a skipped row, or a row imported without its course).
export const courseLink = (
  {
    collection,
    id,
    label,
  }: Pick<Finding, 'collection'> & {
    readonly id: number;
    readonly label: null | string;
  },
  {
    indexes,
    orphan,
  }: { readonly indexes: Indexes; readonly orphan: FindingCode },
): Linked => {
  const link = resolveLabel(label, indexes.courses);
  if (link.resolution === 'unique') {
    return { findings: [], link };
  }
  return {
    findings: [
      link.resolution === 'ambiguous'
        ? detailed(finding('ambiguous_course_name', collection, [id]), {
            related: [{ collection: 'courses', ids: link.matches }],
          })
        : finding(orphan, collection, [id]),
    ],
    link,
  };
};

// The curriculum row an equivalency label names, resolved as a course's
// curriculum name is (several listings of one subject link the first).
const entry = (
  { id, label }: { readonly id: number; readonly label: null | string },
  index: Indexes['current'],
): Linked => {
  const link = resolveCurriculum(label, index);
  const findings: Finding[] = [];
  if (link.resolution === 'ambiguous') {
    findings.push(
      finding('ambiguous_equivalency_entry', 'course_equivalencies', [id]),
    );
  } else if (link.resolution === 'missing') {
    findings.push(
      finding('unmatched_equivalency_entry', 'course_equivalencies', [id]),
    );
  }
  return { findings, link };
};

// Every equivalency row: its course by its 2023 label, and the entry each
// of its 2023 and 2018 labels names.
const equivalencies = (
  rows: WorkbookRows,
  indexes: Indexes,
): {
  readonly candidates: Candidates['equivalencies'];
  readonly findings: readonly Finding[];
} => {
  const results = rows.course_equivalencies.map((row) => {
    const label = nonEmpty(row.course_2023);
    const linked = courseLink(
      { collection: 'course_equivalencies', id: row.id, label },
      { indexes, orphan: 'orphan_equivalency' },
    );
    const entry2023 = entry({ id: row.id, label }, indexes.current);
    const entry2018 = entry(
      { id: row.id, label: nonEmpty(row.course_2018) },
      indexes.legacy,
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

// Every teaching row becomes role rows (course, staff, role, display
// text): its course by label, and each staff text resolved. A row naming
// no course is skipped, so its texts are not reported. A later row of a
// course one row already names is no candidate: it is neither planned
// nor checked (the course reports it, duplicateAssignment).
const assignments = (
  rows: WorkbookRows,
  indexes: Indexes,
): {
  readonly candidates: Candidates['assignments'];
  readonly findings: readonly Finding[];
} => {
  const results = rows.teaching_assignments.flatMap((row) => {
    const label = nonEmpty(row.course_name);
    const linked = courseLink(
      { collection: 'teaching_assignments', id: row.id, label },
      { indexes, orphan: 'orphan_assignment' },
    );
    const unique = linked.link.resolution === 'unique';
    if (unique && usedAssignment(label, indexes) !== row.id) {
      return [];
    }
    const staff = assignmentStaff(row, indexes.staff);
    return [
      {
        candidate: { course: linked.link, id: row.id, staff },
        findings: [
          ...linked.findings,
          ...(unique ? staffFindings(row, staff) : []),
        ],
      },
    ];
  });
  return {
    candidates: results.map(({ candidate }) => candidate),
    findings: results.flatMap(({ findings }) => findings),
  };
};

export const linkedRows = { assignments, equivalencies };
