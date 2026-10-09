// The year tokens of a typed Слушатели pattern or a history line (plan
// step 13): the years a text writes, found left to right, and the year
// pattern that reads a year written as a token writes it.

// A year written in a pattern or a history line: where it is, the digit
// counts of its parts, the separator between them as written (`/`, `-`,
// `\/`, `\-`; empty for 8 digits and a single year) and the years it names.
export type YearToken = {
  readonly at: number;
  readonly digits: readonly number[];
  readonly end: number;
  readonly separator: string;
  readonly years: readonly number[];
};

type TokenRule = {
  readonly expression: RegExp;
  readonly years: (first: number, second: number) => null | number[];
};

const inRange = (year: number): boolean => year >= 1_990 && year <= 2_049;

const consecutive = (first: number, second: number): null | number[] =>
  inRange(first) && inRange(second) && second === first + 1
    ? [first, second]
    : null;

// The token rules, tried in this order where a digit run starts: 8 digits
// of two consecutive years 1990-2049; such a year, `/` or `-` (optionally
// escaped) and the next year in 4 digits, or in 2; 2 digits, `/` or `-`
// and 2 digits one higher (20xx); any other year 1990-2049. No token
// touches another digit.
const tokenRules: readonly TokenRule[] = [
  {
    expression: /(?<first>\d{4})(?<second>\d{4})(?!\d)/uy,
    years: consecutive,
  },
  {
    expression: /(?<first>\d{4})(?<separator>\\?[/-])(?<second>\d{4})(?!\d)/uy,
    years: consecutive,
  },
  {
    expression: /(?<first>\d{4})(?<separator>\\?[/-])(?<second>\d{2})(?!\d)/uy,
    years: (first, second) =>
      inRange(first) && (first + 1) % 100 === second
        ? [first, first + 1]
        : null,
  },
  {
    expression: /(?<first>\d{2})(?<separator>\\?[/-])(?<second>\d{2})(?!\d)/uy,
    years: (first, second) =>
      second === first + 1 ? [2_000 + first, 2_000 + second] : null,
  },
  {
    expression: /(?<first>\d{4})(?!\d)/uy,
    years: (first) => (inRange(first) ? [first] : null),
  },
];

const digit = /\d/u;

const isDigit = (character: string | undefined): boolean =>
  character !== undefined && digit.test(character);

const tokenAt = (text: string, at: number): null | YearToken => {
  for (const { expression, years } of tokenRules) {
    expression.lastIndex = at;
    const match = expression.exec(text);
    const { first = '', second = '', separator = '' } = match?.groups ?? {};
    const named = match === null ? null : years(Number(first), Number(second));
    if (match !== null && named !== null) {
      return {
        at,
        digits: [first, second]
          .filter((part) => part !== '')
          .map((part) => part.length),
        end: at + match[0].length,
        separator,
        years: named,
      };
    }
  }
  return null;
};

// Every year token of a text, left to right.
export const yearTokens = (text: string): readonly YearToken[] => {
  const tokens: YearToken[] = [];
  let index = 0;
  while (index < text.length) {
    if (!isDigit(text[index]) || isDigit(text[index - 1])) {
      index += 1;
      continue;
    }
    const token = tokenAt(text, index);
    if (token === null) {
      while (isDigit(text[index])) {
        index += 1;
      }
      continue;
    }
    tokens.push(token);
    index = token.end;
  }
  return tokens;
};

// Whether a token names the academic year that starts in `start`: both its
// years, or its one year as that year's start or end.
export const namesYear = ({ years }: YearToken, start: number): boolean =>
  years.length === 2
    ? years[0] === start && years[1] === start + 1
    : years[0] === start || years[0] === start + 1;

// The year pattern that reads a year written as the token writes it, when
// the token names the academic year that starts in `start`.
export const tokenYearPattern = (
  token: YearToken,
  start: number,
): null | string => {
  if (!namesYear(token, start)) {
    return null;
  }
  if (token.years.length === 1) {
    return token.years[0] === start
      ? String.raw`(?<start>\d{4})`
      : String.raw`(?<end>\d{4})`;
  }
  const [first = 4, second = 4] = token.digits;
  const separator = token.separator.replace('\\', '');
  return String.raw`(?<start>\d{${String(first)}})${separator}(?<end>\d{${String(second)}})`;
};
