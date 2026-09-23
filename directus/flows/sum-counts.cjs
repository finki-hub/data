// Run Script body of "Data / Fill legacy rule zeros" (operation
// sum_counts). After every legacy page of one legacy rule page staged its
// nonzero partial counts, read_sums answers the native aggregate
// sum(count) grouped by course and academic year over exactly those pages
// of this claim (check_zeros.cells). This script validates that aggregate
// against the rules of the rule page (read_rules) and answers an explicit
// zero row for every legacy course/year no page counted, which stage_page
// stages as the zero page. The completion sums every staged row of the
// claim and never fills zeros from the rule list, so without these rows a
// legacy pair nobody matched would be missing from course_enrollments.
// Refusals name ids only.
const pagePattern = /^p\d{4,9}$/u;
// Directus answers a sum as text ("4"); at most nine digits fit the
// integer candidate column.
const sumPattern = /^(?:0|[1-9]\d{0,8})$/u;

const whole = function (value, least) {
  return Number.isSafeInteger(value) && value >= least;
};

const refuse = function (message) {
  throw new Error(`${message}; nothing was staged.`);
};

const onlyKeys = function (value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const present = Object.keys(value).toSorted();
  return (
    present.length === keys.length &&
    present.every((key, index) => key === keys[index])
  );
};

const checkedPage = function (page) {
  if (
    page === null ||
    typeof page !== 'object' ||
    typeof page.token !== 'string' ||
    !pagePattern.test(page.token) ||
    !whole(page.from, 1) ||
    !whole(page.to, page.from) ||
    !whole(page.rows, 1) ||
    !Array.isArray(page.cells)
  ) {
    refuse('check_zeros answered no planned zero page');
  }
  return page;
};

// The course/year pairs of the rule page, in rule order.
const rulePairs = function (rules, page) {
  if (!Array.isArray(rules) || rules.length !== page.rows) {
    refuse(
      `Read ${Array.isArray(rules) ? rules.length : 'no'} legacy rules of page ${page.token}, planned ${page.rows}`,
    );
  }
  const ids = new Set();
  const pairs = new Map();
  for (const rule of rules) {
    if (
      rule === null ||
      typeof rule !== 'object' ||
      !whole(rule.id, page.from) ||
      rule.id > page.to ||
      ids.has(rule.id)
    ) {
      refuse(`read_rules answered a rule outside page ${page.token}`);
    }
    ids.add(rule.id);
    if (!whole(rule.course, 1) || !whole(rule.academic_year, 1)) {
      refuse(`Rule ${rule.id} has no course or academic year id`);
    }
    const key = `${rule.course}/${rule.academic_year}`;
    if (pairs.has(key)) {
      refuse(
        `Rule ${rule.id} repeats course ${rule.course} / academic year ${rule.academic_year}`,
      );
    }
    pairs.set(key, { academic_year: rule.academic_year, course: rule.course });
  }
  return pairs;
};

const sumOf = function (row) {
  if (
    !onlyKeys(row, ['academic_year', 'course', 'sum']) ||
    !onlyKeys(row.sum, ['count']) ||
    !whole(row.course, 1) ||
    !whole(row.academic_year, 1)
  ) {
    refuse(
      'read_sums must answer the sum of count grouped by course and academic year and nothing else',
    );
  }
  const value = row.sum.count;
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !sumPattern.test(text)) {
    refuse('read_sums answered a sum that is not a non-negative integer');
  }
  return Number(text);
};

const sumCounts = (data) => {
  const page = checkedPage(data.check_zeros);
  const pairs = rulePairs(data.read_rules, page);
  const sums = data.read_sums;
  if (!Array.isArray(sums)) {
    refuse('read_sums returned no aggregate list');
  }
  const counted = new Set();
  let total = 0;
  for (const row of sums) {
    const sum = sumOf(row);
    const key = `${row.course}/${row.academic_year}`;
    if (!pairs.has(key)) {
      refuse(
        `read_sums answered course ${row.course} / academic year ${row.academic_year}, which no legacy rule of page ${page.token} names`,
      );
    }
    if (counted.has(key)) {
      refuse(
        `read_sums answered course ${row.course} / academic year ${row.academic_year} twice`,
      );
    }
    counted.add(key);
    total += sum;
  }
  const rows = [];
  for (const [key, pair] of pairs) {
    if (!counted.has(key)) {
      rows.push({
        academic_year: pair.academic_year,
        count: 0,
        course: pair.course,
      });
    }
  }
  return {
    counted: counted.size,
    rows,
    rules: pairs.size,
    total,
    zeros: rows.length,
  };
};

module.exports = sumCounts;
