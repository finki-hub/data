// Run Script body of "Data / Count legacy rules page" (operation
// count_page). It counts one legacy page: at most 250 Moodle users of one
// planned history page (read_users: id and Courses only, at most 800,000
// UTF-8 bytes) against at most 500 legacy_regex rules of one planned rule
// page (read_rules, at most 1,000,000 UTF-8 bytes of pattern). Every rule
// runs exactly as written: new RegExp(pattern, 'u') over the whole raw
// history, tested once per user, names never escaped, so an expression
// may cross line boundaries and a repeated entry counts once.
// Everything is validated before a pattern runs; a refusal names ids and
// sizes only, never a history, a pattern or a name. The answer holds the
// nonzero partial counts of the page, which stage_page stages; the zero
// page of the rule page adds the explicit zeros later.
const maxUsers = 250;
const maxRules = 500;
// The UTF-8 byte budgets of one page (historyPageBudget and
// legacyPatternBudget of the coordinator, which plans pages within them).
const budget = 800_000;
const patternBudget = 1_000_000;
const pagePattern = /^p\d{4,9}$/u;

const whole = function (value, least) {
  return Number.isSafeInteger(value) && value >= least;
};

const isRange = function (value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    whole(value.from, 1) &&
    whole(value.to, value.from) &&
    whole(value.rows, 1)
  );
};

// UTF-8 bytes, as octet_length measures the stored text: one code point
// at a time, a supplementary one spanning two UTF-16 units.
const utf8Bytes = function (text) {
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.codePointAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x8_00) {
      bytes += 2;
    } else if (code < 0x1_00_00) {
      bytes += 3;
    } else {
      bytes += 4;
      index += 1;
    }
    index += 1;
  }
  return bytes;
};

// The leaf form of every Flow refusal, `<place>: <fault>`: a sandboxed
// copy of refuseFragment in src/flows/text-fragments.ts.
const refuse = function (place, fault) {
  throw new Error(`${place}: ${fault}`);
};

const checkedPage = function (page) {
  if (
    page === null ||
    typeof page !== 'object' ||
    typeof page.token !== 'string' ||
    !pagePattern.test(page.token) ||
    page.users === null ||
    typeof page.users !== 'object' ||
    !isRange(page.users) ||
    !whole(page.users.bytes, 0) ||
    !isRange(page.rules) ||
    !whole(page.rules.bytes, 0)
  ) {
    refuse('check_page', 'no planned legacy page');
  }
  return page;
};

const checkUsers = function (users, page) {
  if (!Array.isArray(users)) {
    refuse('read_users', 'no user list');
  }
  const place = `Page ${page.token}`;
  if (users.length !== page.users.rows) {
    refuse(place, `users ${users.length}, planned ${page.users.rows}`);
  }
  if (users.length > maxUsers) {
    refuse(place, `users ${users.length}, max ${maxUsers}`);
  }
  const seen = new Set();
  let bytes = 0;
  for (const user of users) {
    if (
      user === null ||
      typeof user !== 'object' ||
      !whole(user.id, page.users.from) ||
      user.id > page.users.to ||
      seen.has(user.id)
    ) {
      refuse('read_users', `user outside page ${page.token}`);
    }
    seen.add(user.id);
    if (typeof user.Courses === 'string') {
      bytes += utf8Bytes(user.Courses);
    }
  }
  if (bytes > budget) {
    refuse(place, `Courses history ${bytes} bytes, max ${budget}`);
  }
  if (bytes !== page.users.bytes) {
    refuse(
      place,
      `Courses history ${bytes} bytes, planned ${page.users.bytes}`,
    );
  }
};

const checkRule = function (rule, page, pairs) {
  if (
    rule === null ||
    typeof rule !== 'object' ||
    !whole(rule.id, page.rules.from) ||
    rule.id > page.rules.to
  ) {
    refuse('read_rules', `rule outside page ${page.token}`);
  }
  if (!whole(rule.course, 1) || !whole(rule.academic_year, 1)) {
    refuse(`Rule ${rule.id}`, 'course or academic_year missing');
  }
  if (typeof rule.pattern !== 'string' || rule.pattern.length === 0) {
    refuse(`Rule ${rule.id}`, 'pattern missing');
  }
  const pair = `${rule.course}/${rule.academic_year}`;
  if (pairs.has(pair)) {
    refuse(
      `Rule ${rule.id}`,
      `duplicate pair course ${rule.course} / academic year ${rule.academic_year}`,
    );
  }
  pairs.add(pair);
};

const checkRules = function (rules, page) {
  if (!Array.isArray(rules)) {
    refuse('read_rules', 'no rule list');
  }
  const place = `Page ${page.token}`;
  if (rules.length !== page.rules.rows) {
    refuse(place, `rules ${rules.length}, planned ${page.rules.rows}`);
  }
  if (rules.length > maxRules) {
    refuse(place, `rules ${rules.length}, max ${maxRules}`);
  }
  const ids = new Set();
  const pairs = new Set();
  let bytes = 0;
  for (const rule of rules) {
    checkRule(rule, page, pairs);
    if (ids.has(rule.id)) {
      refuse('read_rules', `rule outside page ${page.token}`);
    }
    ids.add(rule.id);
    bytes += utf8Bytes(rule.pattern);
  }
  if (bytes > patternBudget) {
    refuse(place, `patterns ${bytes} bytes, max ${patternBudget}`);
  }
  if (bytes !== page.rules.bytes) {
    refuse(place, `patterns ${bytes} bytes, planned ${page.rules.bytes}`);
  }
};

// The reason of a SyntaxError without the pattern it quotes.
const reasonOf = function (error) {
  const text = error instanceof Error ? error.message : String(error);
  return (text.split(': ').at(-1) ?? 'invalid').slice(0, 80);
};

const compile = function (rule) {
  try {
    return new RegExp(rule.pattern, 'u');
  } catch (error) {
    return refuse(
      `Rule ${rule.id} (course ${rule.course} / academic year ${rule.academic_year})`,
      `pattern does not compile as a unicode regular expression (${reasonOf(error)})`,
    );
  }
};

const countHistoryPage = (data) => {
  const page = checkedPage(data.check_page);
  const users = data.read_users;
  const rules = data.read_rules;
  checkUsers(users, page);
  checkRules(rules, page);
  const matchers = rules.map(compile);
  const rows = [];
  for (const [index, rule] of rules.entries()) {
    const matcher = matchers[index];
    const count = users.reduce(
      (total, row) =>
        total +
        (typeof row.Courses === 'string' && matcher.test(row.Courses) ? 1 : 0),
      0,
    );
    if (count > 0) {
      rows.push({
        academic_year: rule.academic_year,
        count,
        course: rule.course,
      });
    }
  }
  return { rows, rules: rules.length, users: users.length };
};

module.exports = countHistoryPage;
