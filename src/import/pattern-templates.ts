import { patternProblem } from '../../directus/extensions/directus-extension-data-operations/src/enrollment-lines.js';
import {
  namesYear,
  tokenYearPattern,
  type YearToken,
  yearTokens,
} from './pattern-tokens.js';

// The templates and branches of a typed Слушатели pattern, and the two ways
// a branch generalises to every year (plan step 13). Pure text functions;
// the history lines a branch matches come from the caller.

// A text with every token replaced by its written form and its years
// relative to `start`, such as `Компјутерски компоненти {YYYY:0}`: cells
// of one course with one template differ only in their year.
export const templateOf = (text: string, start: number): string => {
  let template = '';
  let position = 0;
  for (const token of yearTokens(text)) {
    const form = text.slice(token.at, token.end).replaceAll(/\d/gu, 'Y');
    const offsets = token.years.map((year) => year - start).join(',');
    template += `${text.slice(position, token.at)}{${form}:${offsets}}`;
    position = token.end;
  }
  return template + text.slice(position);
};

// The index of the parenthesis that closes the text's first one, escapes
// and character classes honoured; -1 without one.
const closingParenthesis = (text: string): number => {
  let depth = 0;
  let inClass = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') {
      index += 1;
    } else if (inClass) {
      inClass = character !== ']';
    } else if (character === '[') {
      inClass = true;
    } else if (character === '(' || character === ')') {
      depth += character === '(' ? 1 : -1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
};

// The text inside one capturing group that wraps the whole text.
const unwrapped = (text: string): string =>
  text.startsWith('(') &&
  !text.startsWith('(?') &&
  closingParenthesis(text) === text.length - 1
    ? text.slice(1, -1)
    : text;

// The alternatives of a pattern: one capturing group around the whole
// pattern unwrapped, then split on `|` outside groups and character
// classes, escapes honoured, and a branch wrapped in its own group
// unwrapped too.
export const branchesOf = (pattern: string): readonly string[] => {
  const text = unwrapped(pattern);
  const branches: string[] = [];
  let depth = 0;
  let inClass = false;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') {
      index += 1;
    } else if (inClass) {
      inClass = character !== ']';
    } else if (character === '[') {
      inClass = true;
    } else if (character === '(' || character === ')') {
      depth += character === '(' ? 1 : -1;
    } else if (character === '|' && depth === 0) {
      branches.push(text.slice(start, index));
      start = index + 1;
    }
  }
  branches.push(text.slice(start));
  return branches.map(unwrapped);
};

// The one token of a branch that names the cell's academic year, or null.
export const ownToken = (branch: string, start: number): null | YearToken => {
  const own = yearTokens(branch).filter((token) => namesYear(token, start));
  return own.length === 1 ? (own[0] ?? null) : null;
};

// Whether the character at `index` is escaped by a backslash.
const isEscaped = (text: string, index: number): boolean => {
  let backslashes = 0;
  while (text[index - backslashes - 1] === '\\') {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
};

// A text without a leading `.*` and a trailing (unescaped) `.*`.
const withoutOuterWildcards = (text: string): string => {
  const head = text.startsWith('.*') ? text.slice(2) : text;
  return head.endsWith('.*') && !isEscaped(head, head.length - 2)
    ? head.slice(0, -2)
    : head;
};

// The digit class that stands for a token in a generalised branch.
const digitClass = ({ digits, separator }: YearToken): string =>
  separator === '' && digits.length === 2
    ? String.raw`\d{8}`
    : digits.map((count) => String.raw`\d{${String(count)}}`).join(separator);

export type BranchKind = 'A' | 'B';

// A branch generalised to every year, or null when it cannot be: kind A
// keeps the text before the token naming the cell's year (trailing white
// space dropped), kind B puts the token's digit class in its place. A leading or
// trailing `.*` goes; an empty or invalid result is no generalisation.
export const generalisedBranch = (
  branch: string,
  start: number,
  kind: BranchKind,
): null | string => {
  const token = ownToken(branch, start);
  if (token === null) {
    return null;
  }
  const before = branch.slice(0, token.at);
  const text = withoutOuterWildcards(
    kind === 'A'
      ? before.trimEnd()
      : `${before}${digitClass(token)}${branch.slice(token.end)}`,
  );
  return text === '' || patternProblem(text) !== null ? null : text;
};

// The year pattern of a branch: the form in which the history lines it
// matches write the cell's year (each line's first token naming it) when
// every line gives the same one, else the form of the branch's own token.
export const branchYearPattern = (
  branch: string,
  start: number,
  matchedLines: readonly string[],
): null | string => {
  const token = ownToken(branch, start);
  if (token === null) {
    return null;
  }
  const forms = new Set(
    matchedLines.map((line) => {
      const named = yearTokens(line).find((candidate) =>
        namesYear(candidate, start),
      );
      return named === undefined ? null : tokenYearPattern(named, start);
    }),
  );
  const [form = null] = forms;
  return forms.size === 1 && form !== null
    ? form
    : tokenYearPattern(token, start);
};
