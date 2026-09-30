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

// The leaf form of every Flow refusal, `<place>: <fault>`: a sandboxed
// copy of refuseFragment in src/flows/text-fragments.ts.
const refuse = function (place, fault) {
  throw new Error(`${place}: ${fault}`);
};

const countMappedEnrollments = (data) => {
  const request = data.$trigger;
  if (request === null || typeof request !== 'object') {
    refuse(
      'Invalid trigger payload',
      'expected {course, academic_year, revision, claim}',
    );
  }
  if (!positive(request.course) || !positive(request.academic_year)) {
    refuse(
      'Invalid trigger payload',
      'course, academic_year must be positive integers',
    );
  }
  if (!Number.isSafeInteger(request.revision) || request.revision < 0) {
    refuse(
      'Invalid trigger payload',
      'revision must be a non-negative integer',
    );
  }
  const rows = data.read_count;
  if (!Array.isArray(rows) || rows.length !== 1) {
    refuse('read_count', 'expected 1 aggregate row');
  }
  const [row] = rows;
  if (!onlyKey(row, 'countDistinct') || !onlyKey(row.countDistinct, 'id')) {
    refuse('read_count', 'expected countDistinct(id) only');
  }
  const value = row.countDistinct.id;
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !countPattern.test(text)) {
    refuse('read_count', 'count not a non-negative integer');
  }
  return {
    academic_year: request.academic_year,
    count: Number(text),
    course: request.course,
    revision: request.revision,
  };
};

module.exports = countMappedEnrollments;
