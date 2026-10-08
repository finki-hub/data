import { type MemoryRow, type MemoryStore, storedRow } from './memory-store.js';

// The enrollment counts of a memory store: the course_enrollments rows the
// export engine reads, one per course and published academic year.
export type ProjectedCounts = {
  // Whether the counts are derived from the Moodle histories. While they
  // are not, every count is 0 and the year keys of courses.json say
  // nothing about the data, so the live check does not compare them.
  readonly derived: boolean;
  readonly rows: readonly MemoryRow[];
};

// The count seam of the projection. Counts are not derived here: every
// course counts 0 in every published academic year, so courses.json
// carries every year key, each from the one count row the engine
// requires.
export const projectedCounts = (store: MemoryStore): ProjectedCounts => {
  const courses = store.items.get('courses') ?? [];
  const years = (store.items.get('academic_years') ?? []).filter(
    (year) => year['published'] === true,
  );
  return {
    derived: false,
    rows: courses.flatMap((course, index) =>
      years.map((year, offset) =>
        storedRow(
          'course_enrollments',
          { academic_year: year.id, count: 0, course: course.id },
          index * years.length + offset + 1,
        ),
      ),
    ),
  };
};
