// Run Script body of "Data / Match history lines" (operation match_lines).
// It matches one planned page of history lines: at most 250
// moodle_course_entries of the page's id range ($trigger {token, from, to,
// rows}; read_entries: id and label) against every pattern mapping
// (read_mappings: id, pattern, year_pattern, only_in_year; count_mappings:
// their number, as one aggregate row). Each pattern and year pattern is
// compiled once with the u flag and tested against the whole line. An
// only-in-year mapping stages its matches with no year; an all-years
// mapping stages the academic year its year pattern reads from the line,
// by the rule of lineYear in the data-operations bundle
// (src/enrollment-lines.ts), and a line where it reads none is not staged.
// Everything is validated before a pattern runs; a refusal names ids and
// counts only, never a label or a pattern. The answer's rows are what
// stage_page stages into data_operation_matches, at most maxRowsPerPage of
// the coordinator.
const maxEntries = 250;
const maxRows = 10_000;
const pagePattern = /^p\d{4,9}$/u;
const capturedYear = /^(?:\d{2}|\d{4})$/u;
const countText = /^\d{1,15}$/u;

const whole = function (value, least) {
  return Number.isSafeInteger(value) && value >= least;
};

const isObject = function (value) {
  return value !== null && typeof value === 'object';
};

const isText = function (value) {
  return typeof value === 'string' && value.length > 0;
};

const isEmpty = function (value) {
  return value === null || value === undefined;
};

// The leaf form of every Flow refusal, `<place>: <fault>`: a sandboxed
// copy of refuseFragment in src/flows/text-fragments.ts.
const refuse = function (place, fault) {
  throw new Error(`${place}: ${fault}`);
};

const checkedPage = function (page) {
  if (
    !isObject(page) ||
    typeof page.token !== 'string' ||
    !pagePattern.test(page.token) ||
    !whole(page.from, 1) ||
    !whole(page.to, page.from) ||
    !whole(page.rows, 1)
  ) {
    refuse('Invalid trigger payload', 'expected {token, from, to, rows}');
  }
  return page;
};

const checkEntries = function (entries, page) {
  if (!Array.isArray(entries)) {
    refuse('read_entries', 'no entry list');
  }
  const place = `Page ${page.token}`;
  if (entries.length !== page.rows) {
    refuse(place, `entries ${entries.length}, planned ${page.rows}`);
  }
  if (entries.length > maxEntries) {
    refuse(place, `entries ${entries.length}, max ${maxEntries}`);
  }
  const seen = new Set();
  for (const entry of entries) {
    if (
      !isObject(entry) ||
      !whole(entry.id, page.from) ||
      entry.id > page.to ||
      seen.has(entry.id)
    ) {
      refuse('read_entries', `entry outside page ${page.token}`);
    }
    seen.add(entry.id);
    if (!isText(entry.label)) {
      refuse(`History line ${entry.id}`, 'label missing');
    }
  }
};

const checkMapping = function (mapping, ids) {
  if (!isObject(mapping) || !whole(mapping.id, 1)) {
    refuse(
      'read_mappings',
      'expected {id, pattern, year_pattern, only_in_year}',
    );
  }
  const place = `Pattern mapping ${mapping.id}`;
  if (ids.has(mapping.id)) {
    refuse(place, 'duplicate');
  }
  ids.add(mapping.id);
  if (!isText(mapping.pattern)) {
    refuse(place, 'pattern missing');
  }
  const allYears =
    isText(mapping.year_pattern) && isEmpty(mapping.only_in_year);
  const oneYear =
    whole(mapping.only_in_year, 1) && isEmpty(mapping.year_pattern);
  if (!allYears && !oneYear) {
    refuse(place, 'expected exactly one of year_pattern, only_in_year');
  }
};

// The number of pattern mappings count_mappings read: one aggregate row
// whose count is a whole number (PostgreSQL counts arrive as text).
const mappingCount = function (answer) {
  const row = Array.isArray(answer) && answer.length === 1 ? answer[0] : null;
  const value = isObject(row) && isObject(row.count) ? row.count.id : null;
  const count =
    typeof value === 'string' && countText.test(value) ? Number(value) : value;
  if (!whole(count, 0)) {
    refuse('count_mappings', 'expected 1 count row');
  }
  return count;
};

// Directus cuts a read with limit -1 at QUERY_LIMIT_MAX, so a list shorter
// than the count is refused: the mappings past the cut would match nothing.
const checkMappings = function (mappings, counted) {
  if (!Array.isArray(mappings)) {
    refuse('read_mappings', 'no mapping list');
  }
  const expected = mappingCount(counted);
  if (mappings.length !== expected) {
    refuse(
      'read_mappings',
      `mappings ${mappings.length}, expected ${expected}`,
    );
  }
  const ids = new Set();
  for (const mapping of mappings) {
    checkMapping(mapping, ids);
  }
};

// The reason of a SyntaxError without the pattern it quotes.
const reasonOf = function (error) {
  const text = error instanceof Error ? error.message : String(error);
  return (text.split(': ').at(-1) ?? 'invalid').slice(0, 80);
};

const compile = function (text, place, kind) {
  try {
    return new RegExp(text, 'u');
  } catch (error) {
    return refuse(place, `invalid ${kind} (${reasonOf(error)})`);
  }
};

// A year pattern must declare a group named start or end: with an empty
// alternative added it matches the empty text, and the match lists every
// group it declares (yearPatternProblem in src/enrollment-lines.ts).
const compileYear = function (text, place) {
  const matcher = compile(text, place, 'year pattern');
  const groups =
    compile(`${text}|`, place, 'year pattern').exec('')?.groups ?? {};
  if (!('start' in groups) && !('end' in groups)) {
    refuse(place, 'invalid year pattern (no group named start or end)');
  }
  return matcher;
};

const prepared = function (mapping) {
  const place = `Pattern mapping ${mapping.id}`;
  return {
    id: mapping.id,
    pattern: compile(mapping.pattern, place, 'regular expression'),
    year: isEmpty(mapping.year_pattern)
      ? null
      : compileYear(mapping.year_pattern, place),
  };
};

// A captured year: 4 digits as written, 2 digits as 20xx, NaN for any other
// capture; undefined when the group did not take part.
const yearValue = function (text) {
  if (text === undefined || !capturedYear.test(text)) {
    return text === undefined ? text : NaN;
  }
  return text.length === 2 ? 2_000 + Number(text) : Number(text);
};

// The academic year `<start>/<start+1>` of the first match of a year
// pattern on the whole line, or null: the rule of lineYear, which a unit
// test runs on the same vectors.
const lineYear = function (matcher, label) {
  const match = matcher.exec(label);
  const groups = match === null ? {} : (match.groups ?? {});
  const end = yearValue(groups.end);
  const start = yearValue(groups.start);
  const first = start ?? (end === undefined ? NaN : end - 1);
  return Number.isSafeInteger(first) && (end === undefined || end === first + 1)
    ? `${first}/${first + 1}`
    : null;
};

// The row a mapping stages for a line, or null: none when its pattern does
// not match, or when it reads its year from the line and reads none.
const stagedRow = function (matcher, entry) {
  if (!matcher.pattern.test(entry.label)) {
    return null;
  }
  const year =
    matcher.year === null ? null : lineYear(matcher.year, entry.label);
  return matcher.year !== null && year === null
    ? null
    : { entry: entry.id, pattern_mapping: matcher.id, year_label: year };
};

const matchHistoryLines = (data) => {
  const page = checkedPage(data.$trigger);
  const entries = data.read_entries;
  const mappings = data.read_mappings;
  checkEntries(entries, page);
  checkMappings(mappings, data.count_mappings);
  const matchers = mappings.map(prepared);
  const rows = [];
  for (const entry of entries) {
    for (const matcher of matchers) {
      const row = stagedRow(matcher, entry);
      if (row !== null) {
        rows.push(row);
      }
    }
  }
  if (rows.length > maxRows) {
    refuse(`Page ${page.token}`, `matches ${rows.length}, max ${maxRows}`);
  }
  return { entries: entries.length, mappings: mappings.length, rows };
};

module.exports = matchHistoryLines;
