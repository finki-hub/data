import { maxRowsPerPage } from './coordination/state.js';

// The exact Moodle course-history contract that Search and the index share:
// an entry is one complete LF- or CRLF-separated line of the raw `Courses`
// text, a trailing lone CR is dropped, empty lines are ignored and nothing
// else is normalised (no trimming, case folding or transliteration). The
// Search extension keeps its own copy of the splitter; a unit test runs both
// over one vector and asserts identical labels.
const historySeparator = /\r?\n/u;
const trailingCarriageReturn = /\r$/u;

// Every non-empty line of a raw history, repeats included, in history order.
export const splitHistoryLines = (
  history: null | string | undefined,
): string[] =>
  (history ?? '')
    .split(historySeparator)
    .map((line) => line.replace(trailingCarriageReturn, ''))
    .filter((line) => line.length > 0);

// The distinct entries of one history in first-occurrence order; the index
// of an entry in the result is its sort position inside the index.
export const splitHistoryEntries = (
  history: null | string | undefined,
): string[] => [...new Set(splitHistoryLines(history))];

// Exactly the strings the splitter can emit: not empty and without a line
// feed. Only one trailing CR is dropped per line, so a label may still end
// in CR (the raw line `L\r\r` yields `L\r`), and any such string L comes
// back unchanged from the raw text `L\r`.
export const isExactLabel = (label: string): boolean =>
  label.length > 0 && !label.includes('\n');

// The unique btree index on `label` holds at most about 2.7 kB per entry;
// a longer line is refused with a bounded error naming its user instead of
// failing inside the database.
export const maxLabelBytes = 2_048;

const encoder = new TextEncoder();

export const labelBytes = (label: string): number =>
  encoder.encode(label).length;

// Why the entries of one user cannot be indexed, or null. The caller names
// the user; the text never quotes a label.
export const historyRowProblem = (
  entries: readonly string[],
): null | string => {
  if (entries.length > maxRowsPerPage) {
    return `${entries.length} distinct history lines, one user holds at most ${maxRowsPerPage}`;
  }
  if (entries.some((entry) => !isExactLabel(entry))) {
    return 'an entry is empty or contains a line feed, which the splitter never emits';
  }
  let longest = 0;
  for (const entry of entries) {
    longest = Math.max(longest, labelBytes(entry));
  }
  return longest > maxLabelBytes
    ? `a history line of ${longest} bytes, one entry holds at most ${maxLabelBytes} bytes; shorten that line in the raw Courses history`
    : null;
};

// One Moodle user of an index page with the exact entries of its history.
export type HistoryRow = {
  readonly entries: readonly string[];
  readonly id: number;
};

// One row of moodle_history_memberships: a user carries an entry, at the
// position of the entry's first occurrence inside the raw history.
export type MembershipRow = {
  readonly entry: number;
  readonly moodle_user: number;
  readonly sort: number;
};

const numeric = (left: number, right: number): number => left - right;

// User ids that occur more than once in one page payload; a page must name
// each user once, or a later row would silently replace an earlier one.
export const duplicateUserIds = (rows: readonly HistoryRow[]): number[] => {
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const { id } of rows) {
    if (seen.has(id)) {
      duplicates.add(id);
    }
    seen.add(id);
  }
  return [...duplicates].sort(numeric);
};

// How a page's user ids differ from the users its planned range holds at
// the claimed revision: planned users the page left out, and ids the range
// does not hold. Both zero means the page covers exactly its range.
export const pageCoverage = (
  planned: readonly number[],
  named: readonly number[],
): { readonly missing: number; readonly unexpected: number } => {
  const plannedIds = new Set(planned);
  const namedIds = new Set(named);
  return {
    missing: planned.filter((id) => !namedIds.has(id)).length,
    unexpected: named.filter((id) => !plannedIds.has(id)).length,
  };
};

// The distinct labels of a page in first-seen order.
export const pageLabels = (rows: readonly HistoryRow[]): string[] => [
  ...new Set(rows.flatMap(({ entries }) => entries)),
];

export const missingLabels = (
  labels: readonly string[],
  known: ReadonlyMap<string, number>,
): string[] => labels.filter((label) => !known.has(label));

// The memberships of a page: one row per distinct user/entry pair, sorted
// by user and first occurrence so every replay writes the same rows in the
// same order. A label without an entry id is a writer bug, never data.
export const planMemberships = (
  rows: readonly HistoryRow[],
  entryIds: ReadonlyMap<string, number>,
): MembershipRow[] =>
  rows
    .toSorted((left, right) => numeric(left.id, right.id))
    .flatMap((row) =>
      [...new Set(row.entries)].map((label, sort) => {
        const entry = entryIds.get(label);
        if (entry === undefined) {
          throw new Error(
            `No entry id for history label ${JSON.stringify(label)}`,
          );
        }
        return { entry, moodle_user: row.id, sort };
      }),
    );
