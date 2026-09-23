import { z } from 'zod';

import type { DirectusRequest } from '../directus-request.js';
import type { ProposalInput, ProposalMapping } from './enrollment-rules.js';
import type { Inventory } from './inventory.js';
import type { MigrationReport } from './report.js';

import { readColumnsOrNull } from './inventory-fields.js';
import { nonEmpty } from './labels.js';
import { readAll } from './paging.js';

// What the dry-run feeds the regex-to-mapping proposal (enrollment-rules.ts):
// the explicit mappings read from the relational model and the candidate
// rules and histories of the inventory.

const id = z.number().int();
const mappingRow = z.object({
  academic_year: id.nullable(),
  course: id.nullable(),
  entry: id.nullable(),
  id,
});
const entryRow = z.object({ id, label: z.string() });

export type YearLabel = {
  readonly id: number;
  readonly label: null | string;
};

// The explicit mappings of history entries, by exact entry label and year
// label, for the regex-to-mapping proposal. Read-only; none before the
// relational model is installed. A mapping missing its entry, course or
// year counts for no pair.
export const readProposalMappings = async (
  request: DirectusRequest,
  years: readonly YearLabel[],
): Promise<ProposalMapping[]> => {
  if ((await readColumnsOrNull(request, 'moodle_course_mappings')) === null) {
    return [];
  }
  const mappings = await readAll(request, {
    fields: Object.keys(mappingRow.shape),
    pathname: '/items/moodle_course_mappings',
    schema: mappingRow,
  });
  const entries = await readAll(request, {
    fields: Object.keys(entryRow.shape),
    pathname: '/items/moodle_course_entries',
    schema: entryRow,
  });
  const labels = new Map(entries.map((entry) => [entry.id, entry.label]));
  const yearLabels = new Map(years.map((year) => [year.id, year.label]));
  return mappings.flatMap((mapping) => {
    const label =
      mapping.entry === null ? undefined : labels.get(mapping.entry);
    const year =
      mapping.academic_year === null
        ? null
        : (yearLabels.get(mapping.academic_year) ?? null);
    return label === undefined || year === null || mapping.course === null
      ? []
      : [{ academicYear: year, course: mapping.course, label }];
  });
};

// The proposal input of a dry-run: every candidate rule of the preflight
// (the exact pattern the rules converter seeds, with the superseded pattern
// rows of its course and year), the inventoried histories and the mappings.
export const proposalInputs = (
  inventory: Inventory,
  report: MigrationReport,
  mappings: readonly ProposalMapping[],
): ProposalInput => {
  const patterns = new Map(
    inventory.checkpoint.course_enrollment_patterns.map((row) => [
      row.id,
      row.pattern,
    ]),
  );
  return {
    mappings,
    rules: report.candidates.courses.flatMap((course) =>
      course.rules.map((rule) => ({
        academicYear: rule.academicYear,
        alternatives: rule.overrides
          .filter((row) => row !== rule.chosen)
          .flatMap((row) => {
            const pattern = nonEmpty(patterns.get(row));
            return pattern === null ? [] : [{ pattern, row }];
          }),
        course: course.id,
        pattern: rule.pattern,
      })),
    ),
    users: inventory.checkpoint.moodle_users,
  };
};
