import type { Candidates } from './candidates.js';

import { linkedRow } from './labels.js';
import {
  compositeKey,
  planned,
  type PlannedRecord,
  type PlannedRow,
  ref,
} from './planned.js';

// The role rows of every teaching row whose course label names exactly one
// course: one per staff member a text names when every complete label
// matches exactly one staff row, in the order the text names them, or one
// row carrying the literal text when it does not. A row naming no course
// is skipped. Names are never split on spaces, and professors_override is
// never read here.
export const planTeachingAssignments = (
  candidates: Candidates['assignments'],
): readonly PlannedRow[] =>
  candidates.flatMap((candidate) => {
    const course = linkedRow(candidate.course);
    if (course === null) {
      return [];
    }
    return candidate.staff.flatMap((item) => {
      if (item.resolution === 'none') {
        return [];
      }
      const values: readonly PlannedRecord[] =
        item.resolution === 'unique'
          ? item.staff.map((id) => ({
              display_override: null,
              staff: ref('staff', id),
            }))
          : [{ display_override: item.text, staff: null }];
      return values.map((value, index) =>
        planned(
          compositeKey(candidate.id, item.role, index + 1),
          {
            ...value,
            course: ref('courses', course),
            role: item.role,
            sort: index + 1,
          },
          { id: candidate.id, source: 'teaching_assignments' },
        ),
      );
    });
  });
