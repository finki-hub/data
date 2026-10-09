import type { Filter } from '@directus/types';

import type { IssueCounts, ReadinessCheck, SourceRead } from './types.js';

import { publishedThrough } from './key-sources.js';
import { countIn } from './values.js';

// The enrollment check of courses.json: a count of every course and
// published year, as bounded counts (never a label or a history).

// A bounded count of the rows of a collection the filter matches.
const counting = (collection: string, filter?: Filter): SourceRead => ({
  aggregate: 'count',
  collection,
  fields: ['id'],
  ...(filter !== undefined && { filter }),
  sort: [],
});

// Every course needs a count row for every published academic year: three
// bounded counts, courses times published years less the count rows of
// published years (one per course and year, by the unique key), so no row
// is read.
export const enrollmentCheck: ReadinessCheck = {
  evaluate: (sources): IssueCounts => ({
    enrollment_count_missing:
      countIn(sources, 'courses') * countIn(sources, 'years') -
      countIn(sources, 'counts'),
  }),
  reads: {
    counts: counting('course_enrollments', publishedThrough('academic_year')),
    courses: counting('courses'),
    years: counting('academic_years', { published: { _eq: true } }),
  },
};
