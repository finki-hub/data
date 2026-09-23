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
import { duplicateRows } from './preflight-duplicates.js';
import { linkedRows } from './preflight-links.js';

export type RowCandidates = Omit<Candidates, 'courses'>;

type Collected<T> = {
  readonly candidates: readonly T[];
  readonly findings: readonly Finding[];
};

const linePattern = /\r?\n/u;

const collect = <T>(
  results: ReadonlyArray<{
    readonly candidate: T;
    readonly findings: readonly Finding[];
  }>,
): Collected<T> => ({
  candidates: results.map(({ candidate }) => candidate),
  findings: results.flatMap(({ findings }) => findings),
});

const patterns = (
  checkpoint: CheckpointRows,
  indexes: Indexes,
  knownYears: ReadonlySet<string>,
): Collected<Candidates['patterns'][number]> =>
  collect(
    checkpoint.course_enrollment_patterns.map((row) => {
      const year = nonEmpty(row.academic_year);
      const findings: Finding[] = [];
      if (
        nonEmpty(row.course_name) === null ||
        year === null ||
        nonEmpty(row.pattern) === null
      ) {
        findings.push(
          finding('invalid_source_row', {
            collection: 'course_enrollment_patterns',
            ids: [row.id],
            label: year,
            message: `pattern row ${String(row.id)} lacks a course name, an academic year or a pattern; the current derivation refuses such a row.`,
          }),
        );
      }
      const knownYear = year !== null && knownYears.has(year);
      if (year !== null && !knownYear) {
        findings.push(
          finding('unknown_academic_year', {
            collection: 'course_enrollment_patterns',
            ids: [row.id],
            label: year,
            message: `pattern row ${String(row.id)} names academic year ${quote(year)}, which the conversion does not seed; it is retained but seeds no rule.`,
          }),
        );
      }
      const course = linkedRows.course(
        {
          collection: 'course_enrollment_patterns',
          id: row.id,
          label: nonEmpty(row.course_name),
        },
        indexes,
      );
      return {
        candidate: {
          academicYear: year,
          course: course.link,
          id: row.id,
          knownYear,
        },
        findings: [...findings, ...course.findings],
      };
    }),
  );

const councilFinding = (
  id: number,
  indexNumber: null | string,
  student: LinkCandidate,
): Finding | null => {
  const base = { collection: 'student_council', ids: [id], label: indexNumber };
  if (indexNumber === null) {
    return finding('invalid_source_row', {
      ...base,
      message: `council row ${String(id)} has no index number; the current derivation refuses such a row.`,
    });
  }
  if (student.resolution === 'ambiguous') {
    return finding('ambiguous_student_index', {
      ...base,
      message: `index ${quote(indexNumber)} matches student rows ${listIds(student.matches)}; the current derivation copies the name of the first ascending id ${String(student.precedent)}. The student link stays empty and every student row is retained until the identity is resolved explicitly.`,
    });
  }
  if (student.resolution === 'missing') {
    return finding('unmatched_council_index', {
      ...base,
      message: `index ${quote(indexNumber)} matches no student row; the council row keeps its copied name and index for review.`,
    });
  }
  return null;
};

const council = (
  checkpoint: CheckpointRows,
  indexes: Indexes,
): Collected<Candidates['council'][number]> =>
  collect(
    checkpoint.student_council.map((row) => {
      const indexNumber = nonEmpty(row.index_number);
      const student = resolveLabel(indexNumber, indexes.students);
      const item = councilFinding(row.id, indexNumber, student);
      return {
        candidate: { id: row.id, indexNumber, student },
        findings: item === null ? [] : [item],
      };
    }),
  );

const discordFinding = (
  id: number,
  channel: null | string,
  link: LinkCandidate,
): Finding | null => {
  const base = { collection: 'discord_channels', ids: [id], label: link.label };
  if (link.resolution === 'ambiguous') {
    return finding('ambiguous_discord_course', {
      ...base,
      message: `channel ${quote(channel)} lists ${quote(link.label)}, which names courses ${listIds(link.matches)}.`,
    });
  }
  if (link.resolution === 'missing') {
    return finding('orphan_discord_course', {
      ...base,
      message: `channel ${quote(channel)} lists ${quote(link.label)}, which names no course; the text is retained.`,
    });
  }
  return null;
};

const discord = (
  checkpoint: CheckpointRows,
  indexes: Indexes,
): Collected<Candidates['discord'][number]> =>
  collect(
    checkpoint.discord_channels.map((row) => {
      const courses = (row.course_names ?? '')
        .split(linePattern)
        .map((label) => label.trim())
        .filter((label) => label !== '')
        .map((label) => resolveLabel(label, indexes.courses));
      return {
        candidate: { channel: row.channel, courses, id: row.id },
        findings: courses.flatMap((link) => {
          const item = discordFinding(row.id, row.channel, link);
          return item === null ? [] : [item];
        }),
      };
    }),
  );

// Row-level candidates and findings for every checkpoint row that links to
// another by label, plus the duplicate rows the model must not guess about.
export const rowCandidates = (
  checkpoint: CheckpointRows,
  indexes: Indexes,
  academicYears: readonly string[],
): {
  readonly candidates: RowCandidates;
  readonly findings: readonly Finding[];
} => {
  const parts = {
    assignments: linkedRows.assignments(checkpoint, indexes),
    council: council(checkpoint, indexes),
    discord: discord(checkpoint, indexes),
    equivalencies: linkedRows.equivalencies(checkpoint, indexes),
    patterns: patterns(checkpoint, indexes, new Set(academicYears)),
  };
  return {
    candidates: {
      assignments: parts.assignments.candidates,
      council: parts.council.candidates,
      discord: parts.discord.candidates,
      equivalencies: parts.equivalencies.candidates,
      patterns: parts.patterns.candidates,
    },
    findings: [
      ...Object.values(parts).flatMap(({ findings }) => findings),
      ...duplicateRows(checkpoint),
    ],
  };
};
