import type { CourseCandidate } from './candidates.js';

import { compositeKey, planned, type PlannedRow, ref } from './planned.js';

// The staff links of every course: one role row per staff row its teaching
// cells name, in cell order, numbered by `sort` from 1, professors first,
// then assistants (professors 1..n, assistants n+1..n+m). A status that
// replaces names links nobody in those cells.
export const planTeachingAssignments = (
  courses: readonly CourseCandidate[],
): readonly PlannedRow[] =>
  courses.flatMap(({ id, teaching }) =>
    teaching.links.map((link, index) =>
      planned(
        compositeKey(id, index + 1),
        {
          course: ref('courses', id),
          role: link.role,
          sort: index + 1,
          staff: ref('staff', link.staff),
        },
        teaching.source,
      ),
    ),
  );
