// The text forms the runtime messages share: counts, bounded lists,
// validation issues, the administrator refusal and dashboard fact lines. Both the API and the app
// bundle import this module, and the root package re-exports its count and
// list forms (src/text.ts), so one situation reads the same everywhere.

// How many items a list names before it adds " (+N more)".
export const listMax = 5;

// How many characters one validation issue keeps.
export const issueLength = 240;

// The noun that agrees with a count: "case" for 1, "cases" otherwise.
export const pluralText = (
  count: number,
  singular: string,
  plural: string,
): string => (count === 1 ? singular : plural);

// A count and its noun: "1 case", "5 cases".
export const countText = (
  count: number,
  singular: string,
  plural: string,
): string => `${String(count)} ${pluralText(count, singular, plural)}`;

type BoundedList = {
  readonly max?: number;
  readonly separator?: string;
  // How many items the whole list holds, when `items` keeps only the
  // first of them.
  readonly total?: number;
};

// Items joined by `separator` (", "), at most `max` of them (five), then
// " (+N more)" for the rest of the whole list.
export const boundedText = (
  items: readonly string[],
  { max = listMax, separator = ', ', total = items.length }: BoundedList = {},
): string => {
  const shown = items.slice(0, max);
  const more = total - shown.length;
  const text = shown.join(separator);
  return more <= 0 ? text : `${text} (+${String(more)} more)`;
};

// Items joined with ", ", at most `max` of them, then " (+N more)".
export const listText = (items: readonly string[], max = listMax): string =>
  boundedText(items, { max });

// A validation issue as a schema library reports it.
export type TextIssue = {
  readonly message: string;
  readonly path: readonly PropertyKey[];
};

// Validation issues on one line: `<path>: <message>` each (the message
// alone for an issue at the root), cut to issueLength characters, joined
// by "; ", at most listMax of them, then " (+N more)". The message is the
// library's own, verbatim.
export const issuesText = (issues: readonly TextIssue[]): string =>
  boundedText(
    issues.map(({ message, path }) =>
      (path.length === 0
        ? message
        : `${path.map(String).join('.')}: ${message}`
      ).slice(0, issueLength),
    ),
    { separator: '; ' },
  );

// Operation options a schema refused: `Invalid options: <issues>`. An
// issue on the action path carries the accepted actions in the library's
// own message.
export const invalidOptionsText = (issues: readonly TextIssue[]): string =>
  `Invalid options: ${issuesText(issues)}`;

// The refusal of a caller who is no administrator: `Only administrators
// may <verb> <object>`. Flows, operations and endpoints answer it with
// FORBIDDEN (or their own forbidden code).
export const adminOnlyText = (action: string): string =>
  `Only administrators may ${action}`;

// Facts of one dashboard line: "Label: value · Label: value".
export const factsText = (
  facts: ReadonlyArray<readonly [label: string, value: number | string]>,
): string =>
  facts.map(([label, value]) => `${label}: ${String(value)}`).join(' · ');
