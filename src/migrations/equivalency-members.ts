import type { Candidates } from './candidates.js';
import type { EquivalencyRow } from './workbook-rows.js';

import { entryKey } from './curricula.js';
import { type EntrySource, workbookGenerations } from './generations.js';
import { type LinkCandidate, uniqueMatch } from './labels.js';
import { compositeKey, planned, type PlannedRow, ref } from './planned.js';

// The members of each equivalency row: one per generation whose label
// column is filled, with the label copied literally and the entry linked
// when the label names exactly one curriculum row of that generation. A
// label-only generation (2013) names no entry.

type Candidate = Candidates['equivalencies'][number];

// The entry candidate of each curriculum sheet.
const entryCandidates: Readonly<
  Record<EntrySource, (candidate: Candidate) => LinkCandidate>
> = {
  curriculum_2018: (candidate) => candidate.entry2018,
  curriculum_2023: (candidate) => candidate.entry2023,
};

// The label columns in sheet order (2023, 2018, 2013), each with its
// generation; the order is the members' sort.
const columns = [...workbookGenerations].toReversed();

const entryOf = (
  candidate: Candidate | undefined,
  sheet: EntrySource | null,
): null | string => {
  if (candidate === undefined || sheet === null) {
    return null;
  }
  const entry = uniqueMatch(entryCandidates[sheet](candidate));
  return entry === null ? null : entryKey(sheet, entry);
};

// Up to three members per equivalency row, one per filled label column,
// in sheet order.
export const planEquivalencyMembers = (
  rows: readonly EquivalencyRow[],
  candidates: Candidates['equivalencies'],
): readonly PlannedRow[] =>
  rows.flatMap((row) => {
    const candidate = candidates.find(({ id }) => id === row.id);
    return columns.flatMap(({ code, equivalencyColumn, sheet }, index) => {
      const label = row[equivalencyColumn];
      if (label === null || label === '') {
        return [];
      }
      const entry = entryOf(candidate, sheet);
      return [
        planned(
          compositeKey(row.id, code),
          {
            entry: entry === null ? null : ref('curriculum_entries', entry),
            equivalency: ref('course_equivalencies', row.id),
            generation: ref('curriculum_generations', code),
            label,
            sort: index + 1,
          },
          { id: row.id, source: 'course_equivalencies' },
        ),
      ];
    });
  });
