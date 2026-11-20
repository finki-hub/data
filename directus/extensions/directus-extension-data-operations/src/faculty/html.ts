// Reading the faculty's pages without a DOM: the few shapes the structure
// import needs (an element's attributes, the text of a fragment, the
// region of a page). Pure.

export type Element = {
  // The text between the opening and the closing tag.
  readonly inner: string;
  // The opening tag, as the page writes it.
  readonly open: string;
};

// A page whose structure the import does not recognise: the run fails and
// the previous data stays.
export class UnrecognizedPageError extends Error {
  public override readonly name = 'UnrecognizedPageError';
}

const named: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  hellip: '...',
  laquo: '«',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  raquo: '»',
  rdquo: '”',
  rsquo: '’',
};

const entity =
  /&(?:#(?<dec>\d+)|#[xX](?<hex>[\da-fA-F]+)|(?<name>[a-zA-Z]+));/gu;
const spaces = /\s+/gu;
const tags = /<[^<>]*>/gu;
const openingTag = /<(?<tag>[a-z][a-z\d]*)(?:\s[^<>]*)?>/giu;
const attributePair =
  /\s(?<name>[\w:-]+)\s*=\s*(?:"(?<double>[^"]*)"|'(?<single>[^']*)')/gu;

const fromCodePoint = (code: number, original: string): string =>
  code > 0 && code <= 0x10_ff_ff ? String.fromCodePoint(code) : original;

// The text of HTML character references: the page writes email addresses
// as numeric ones.
export const decodeEntities = (value: string): string =>
  value.replaceAll(entity, (original, ...rest: unknown[]) => {
    const groups = rest.at(-1) as Record<string, string | undefined>;
    const { dec, hex, name = '' } = groups;
    if (dec !== undefined) {
      return fromCodePoint(Number(dec), original);
    }
    if (hex !== undefined) {
      return fromCodePoint(Number.parseInt(hex, 16), original);
    }
    return named[name] ?? original;
  });

// The text of a fragment: tags dropped, references decoded, whitespace
// collapsed.
export const textOf = (html: string): string =>
  decodeEntities(html.replaceAll(tags, ' ')).replaceAll(spaces, ' ').trim();

// The value of an attribute in the opening tag of an element.
export const attribute = (openTag: string, name: string): null | string => {
  for (const pair of openTag.matchAll(attributePair)) {
    if (pair.groups?.['name'] === name) {
      return decodeEntities(
        pair.groups['double'] ?? pair.groups['single'] ?? '',
      );
    }
  }
  return null;
};

// Every element of a tag, optionally with a class (a whole class name of
// its class list: `dekanat-card` is not `dekanat-card__name`), up to its
// closing tag. The elements of one tag the parsers read do not nest.
export const elements = (
  html: string,
  tag: string,
  className?: string,
): Element[] => {
  const close = `</${tag}>`;
  const found: Element[] = [];
  for (const match of html.matchAll(openingTag)) {
    if (match.groups?.['tag']?.toLowerCase() !== tag) {
      continue;
    }
    const classes = (attribute(match[0], 'class') ?? '').split(spaces);
    if (className !== undefined && !classes.includes(className)) {
      continue;
    }
    const from = match.index + match[0].length;
    const end = html.indexOf(close, from);
    if (end !== -1) {
      found.push({ inner: html.slice(from, end), open: match[0] });
    }
  }
  return found;
};

// The inner HTML of the first element of a tag and class in a fragment.
export const innerOf = (
  html: string,
  tag: string,
  className?: string,
): null | string => elements(html, tag, className)[0]?.inner ?? null;

// The part of a page from the first `from` to the first `to` after it.
export const region = (html: string, from: string, to: string): string => {
  const start = html.indexOf(from);
  if (start === -1) {
    throw new UnrecognizedPageError(`no ${from}`);
  }
  const end = html.indexOf(to, start);
  return html.slice(start, end === -1 ? html.length : end);
};
