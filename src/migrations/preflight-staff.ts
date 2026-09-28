import type { StaffCandidate } from './candidates.js';
import type { AssignmentRow } from './workbook-rows.js';

import { type Finding, finding } from './findings.js';
import { type LabelIndex, nonEmpty } from './labels.js';

const delimiters = [',', ';', '\n'] as const;

type Text = Pick<StaffCandidate, 'role' | 'text'>;

type Matched = Pick<StaffCandidate, 'parts' | 'staff'>;

const candidate = (
  { role, text }: Text,
  resolution: StaffCandidate['resolution'],
  { parts, staff }: Matched,
): StaffCandidate => ({
  parts: [...parts],
  resolution,
  role,
  staff: [...staff],
  text,
});

const unresolved = (base: Text, parts: readonly string[]): StaffCandidate =>
  candidate(base, 'unresolved', { parts, staff: [] });

// Complete labels only: `unique` when every label names exactly one staff
// row (the rows in the order the text names them), `ambiguous` when every
// label names a staff row but at least one names several (the ids in
// contention are carried, none is linked), and `unresolved` when a label
// names no staff row at all.
const fromMatches = (
  base: Text,
  parts: readonly string[],
  matches: ReadonlyArray<readonly number[]>,
): StaffCandidate => {
  if (matches.some((ids) => ids.length === 0)) {
    return unresolved(base, parts);
  }
  if (matches.every((ids) => ids.length === 1)) {
    return candidate(base, 'unique', { parts, staff: matches.flat() });
  }
  const staff = [...new Set(matches.flat())].toSorted(
    (left, right) => left - right,
  );
  return candidate(base, 'ambiguous', { parts, staff });
};

// The one form in which a list of staff labels is published: the export
// joins the labels of a course's role rows with this separator (the
// `labelSeparator` of the data-operations export definitions).
export const staffListSeparator = ', ';

// Links assignment text to staff rows only through complete labels: the
// whole text as one staff name, or a text split on exactly one kind of
// delimiter whose every part is a distinct staff name. Names are never
// split on spaces; a list that repeats a label is not an unambiguous list
// of relations (it would invent a duplicate one), so it and anything else
// stays unresolved text for review. The labels are linked only when the
// export republishes the text unchanged: the whole text without padding,
// or a list whose parts joined by `staffListSeparator` give the text back.
// A list separated by ';', a line break, a bare ',' or padded parts stays
// literal review text, so the import never changes the published text.
export const resolveStaff = (
  role: StaffCandidate['role'],
  raw: null | string,
  staffByName: LabelIndex,
): StaffCandidate => {
  const text = nonEmpty(raw);
  const base = { role, text };
  if (text === null) {
    return candidate(base, 'none', { parts: [], staff: [] });
  }
  const whole = text.trim();
  const wholeMatches = staffByName.get(whole) ?? [];
  if (wholeMatches.length > 0) {
    return whole === text
      ? fromMatches(base, [whole], [wholeMatches])
      : unresolved(base, [whole]);
  }
  const present = delimiters.filter((item) => whole.includes(item));
  const [delimiter] = present;
  if (delimiter === undefined || present.length !== 1) {
    return unresolved(base, [whole]);
  }
  const parts = whole
    .split(delimiter)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (
    parts.length < 2 ||
    new Set(parts).size !== parts.length ||
    parts.join(staffListSeparator) !== text
  ) {
    return unresolved(base, parts);
  }
  return fromMatches(
    base,
    parts,
    parts.map((part) => staffByName.get(part) ?? []),
  );
};

// Both texts of one assignment row.
export const assignmentStaff = (
  row: AssignmentRow,
  staffByName: LabelIndex,
): readonly StaffCandidate[] => [
  resolveStaff('professor', row.professors, staffByName),
  resolveStaff('assistant', row.assistants, staffByName),
];

// One finding per text that links no staff row: kept as display text when
// unresolved, or naming several staff rows when ambiguous.
export const staffFindings = (
  row: AssignmentRow,
  staff: readonly StaffCandidate[],
): readonly Finding[] =>
  staff.flatMap((item) => {
    if (item.resolution === 'ambiguous') {
      return [
        finding('ambiguous_staff_label', 'teaching_assignments', [row.id]),
      ];
    }
    return item.resolution === 'unresolved'
      ? [finding('unresolved_staff_text', 'teaching_assignments', [row.id])]
      : [];
  });
