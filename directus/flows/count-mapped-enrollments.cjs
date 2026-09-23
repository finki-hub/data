// Run Script body of "Data / Count mapped enrollments" (operation
// shape_count). It validates the native aggregate that read_count answered
// for one course/year and shapes the pair's result. A result exists only
// for a well-formed request and exactly one aggregate row carrying a
// non-negative integer: anything else throws, so a failure is never read as
// a zero. The answer holds ids and the count only, never a name, an address
// or a history.
const positive = function (value) {
  return Number.isSafeInteger(value) && value > 0;
};

const onlyKey = function (value, key) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.keys(value)[0] === key
  );
};

// Directus answers a count as text ("2"); at most nine digits fit the
// integer candidate column.
const countPattern = /^(?:0|[1-9]\d{0,8})$/u;

const countMappedEnrollments = (data) => {
  const request = data.$trigger;
  if (request === null || typeof request !== 'object') {
    throw new Error(
      'The count needs {course, academic_year, revision, claim} as its trigger payload.',
    );
  }
  if (!positive(request.course) || !positive(request.academic_year)) {
    throw new Error('course and academic_year must be positive integer ids.');
  }
  if (!Number.isSafeInteger(request.revision) || request.revision < 0) {
    throw new Error('revision must be a non-negative integer.');
  }
  const rows = data.read_count;
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error('read_count must answer exactly one aggregate row.');
  }
  const [row] = rows;
  if (!onlyKey(row, 'countDistinct') || !onlyKey(row.countDistinct, 'id')) {
    throw new Error(
      'read_count must answer countDistinct of id and nothing else.',
    );
  }
  const value = row.countDistinct.id;
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !countPattern.test(text)) {
    throw new Error(
      'read_count answered a count that is not a non-negative integer.',
    );
  }
  return {
    academic_year: request.academic_year,
    count: Number(text),
    course: request.course,
    revision: request.revision,
  };
};

module.exports = countMappedEnrollments;
