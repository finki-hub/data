import type { CourseCandidate } from './candidates.js';
import type { EntrySource } from './generations.js';
import type { CourseRow } from './workbook-rows.js';

import { entryKey } from './curricula.js';
import { type LinkCandidate, linkedRow } from './labels.js';
import {
  compositeKey,
  planned,
  type PlannedRecord,
  type PlannedRow,
  ref,
} from './planned.js';

// The course sheet columns of a workbook generation: the entry its label
// names, and the credits and availability the link carries.
type GenerationSpec = {
  readonly generation: '2018' | '2023';
  readonly link: (candidate: CourseCandidate) => LinkCandidate;
  readonly sheet: EntrySource;
  readonly sort: number;
  readonly values: (row: CourseRow) => PlannedRecord;
};

const generationSpecs: readonly GenerationSpec[] = [
  {
    generation: '2023',
    link: (candidate) => candidate.current,
    sheet: 'curriculum_2023',
    sort: 1,
    values: (row) => ({
      available: row.available_2023,
      credits: row.credits_2023,
    }),
  },
  {
    generation: '2018',
    link: (candidate) => candidate.legacy.entry,
    sheet: 'curriculum_2018',
    sort: 2,
    values: (row) => ({
      available: row.available_2018,
      credits: row.credits_2018,
    }),
  },
];

// One course_curricula link per course and generation whose label names
// one subject: the 2023 entry by its 2023 name, the 2018 entry by its
// override or first equivalency label (the first listing of a subject the
// sheet lists in several semester blocks), with the credits and
// availability of that generation. A course without a label for a
// generation gets no link of it (a label naming no entry or several
// subjects, and credits without a label, refuse the import; an
// availability without a label links nothing, and TRUE is the rule fix
// unlinked_availability).
export const planCourseCurricula = (
  candidates: readonly CourseCandidate[],
  courses: readonly CourseRow[],
): readonly PlannedRow[] =>
  candidates.flatMap((candidate) => {
    const row = courses.find((course) => course.id === candidate.id);
    return generationSpecs.flatMap((spec) => {
      const entry = linkedRow(spec.link(candidate));
      return row === undefined || entry === null
        ? []
        : [
            planned(
              compositeKey(candidate.id, spec.generation),
              {
                ...spec.values(row),
                course: ref('courses', candidate.id),
                entry: ref('curriculum_entries', entryKey(spec.sheet, entry)),
                generation: ref('curriculum_generations', spec.generation),
                sort: spec.sort,
              },
              { id: candidate.id, source: 'courses' },
            ),
          ];
    });
  });
