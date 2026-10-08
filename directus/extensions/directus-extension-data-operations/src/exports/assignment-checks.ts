import type { IssueCounts, ReadinessCheck } from './types.js';

import { sourceRows } from './values.js';

// The teaching check of courses.json, as native reads of ids and statuses
// (never a name), counted per issue code.

// An Active course publishes the names of its professor links, so it
// needs one with a staff member; the projection refuses it otherwise
// (EXPORT_UNRESOLVED). Counts the Active courses without one.
export const professorCheck: ReadinessCheck = {
  evaluate: (sources): IssueCounts => {
    const taught = new Set(
      sourceRows(sources, 'professors').map((row) => row['course']),
    );
    return {
      course_without_professor: sourceRows(sources, 'courses').filter(
        (course) => course['status'] === 'active' && !taught.has(course['id']),
      ).length,
    };
  },
  reads: {
    courses: {
      collection: 'courses',
      fields: ['id', 'status'],
      sort: ['id'],
    },
    professors: {
      collection: 'teaching_assignments',
      fields: ['id', 'course'],
      filter: {
        _and: [
          { course: { _nnull: true } },
          { role: { _eq: 'professor' } },
          { staff: { _nnull: true } },
        ],
      },
      sort: ['id'],
    },
  },
};
