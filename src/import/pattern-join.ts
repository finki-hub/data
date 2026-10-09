// The mappings of one course while the import converts its typed cells
// (plan step 13): at most one all-years mapping per year pattern, its
// pattern a list of alternatives, and the only-in-year mappings by year.
export type CourseMappings = {
  readonly allYears: ReadonlyMap<string, readonly string[]>;
  readonly onlyInYear: ReadonlyMap<string, string>;
};

// A generalised branch and the year pattern of the mapping it joins.
export type Alternative = {
  readonly branch: string;
  readonly yearPattern: string;
};

export const mappingCount = ({ allYears, onlyInYear }: CourseMappings) =>
  allYears.size + onlyInYear.size;

// The characters a backslash makes literal in a Unicode pattern, and the
// metacharacters that end a literal run.
const syntaxCharacters = new Set(String.raw`^$\.*+?()[]{}|/-`);
const metacharacters = new Set(String.raw`^$\.*+?()[]{}|`);
const optionalQuantifiers = new Set(['*', '?', '{']);
const quantifiers = new Set(['*', '+', '?', '{']);

// The literal text every match of a branch starts with, and where it ends
// in the branch: characters up to the first metacharacter (an escaped
// syntax character read as itself), without a character a quantifier
// makes optional.
const literalRun = (
  branch: string,
): { readonly end: number; readonly text: string } => {
  let text = '';
  let index = 0;
  while (index < branch.length) {
    const character = branch[index] ?? '';
    const escaped = character === '\\';
    const literal = escaped ? (branch[index + 1] ?? '') : character;
    const width = escaped ? 2 : 1;
    if (
      (escaped
        ? !syntaxCharacters.has(literal)
        : metacharacters.has(literal)) ||
      optionalQuantifiers.has(branch[index + width] ?? '')
    ) {
      break;
    }
    text += literal;
    index += width;
  }
  return { end: index, text };
};

// The text a branch without metacharacters matches, or null.
const literalText = (branch: string): null | string => {
  const run = literalRun(branch);
  return run.end === branch.length ? run.text : null;
};

// Whether `cover` matches every line `branch` matches, decided on the text
// alone: a literal contained in the branch's leading literal text;
// `L1.*L2` with literal parts, for a literal branch holding L1 and then
// L2; or a prefix of the branch that ends at an atom boundary.
export const covers = (cover: string, branch: string): boolean => {
  if (cover === branch) {
    return false;
  }
  const literal = literalText(cover);
  if (literal !== null && literalRun(branch).text.includes(literal)) {
    return true;
  }
  const parts = cover.split('.*').map(literalText);
  const whole = literalText(branch);
  if (parts.length === 2 && whole !== null) {
    const [first, second] = parts;
    const at =
      first === null || first === undefined ? -1 : whole.indexOf(first);
    if (
      at !== -1 &&
      second !== null &&
      second !== undefined &&
      whole.includes(second, at + (first?.length ?? 0))
    ) {
      return true;
    }
  }
  // Every alternative compiles on its own, so a prefix that is one ends
  // at an atom boundary unless the branch quantifies what follows.
  return (
    branch.startsWith(cover) && !quantifiers.has(branch[cover.length] ?? '')
  );
};

// The alternatives with the added branches joined: a branch already there,
// or covered by one, is not added; a branch that covers existing ones
// takes the first one's place and removes the rest, so the course's own
// name stays first.
export const joinAlternatives = (
  alternatives: readonly string[],
  added: readonly string[],
): readonly string[] => {
  let joined = [...alternatives];
  for (const branch of added) {
    if (
      joined.includes(branch) ||
      joined.some((existing) => covers(existing, branch))
    ) {
      continue;
    }
    const first = joined.findIndex((existing) => covers(branch, existing));
    joined =
      first === -1
        ? [...joined, branch]
        : joined.flatMap((existing, index) => {
            if (index === first) {
              return [branch];
            }
            return covers(branch, existing) ? [] : [existing];
          });
  }
  return joined;
};

// The mappings with the alternatives joined, each to the all-years mapping
// of its year pattern, which is created when missing.
export const withAlternatives = (
  mappings: CourseMappings,
  alternatives: readonly Alternative[],
): CourseMappings => {
  const allYears = new Map(mappings.allYears);
  const byYearPattern = Map.groupBy(
    alternatives,
    (alternative) => alternative.yearPattern,
  );
  for (const [yearPattern, joining] of byYearPattern) {
    allYears.set(
      yearPattern,
      joinAlternatives(
        allYears.get(yearPattern) ?? [],
        joining.map(({ branch }) => branch),
      ),
    );
  }
  return { allYears, onlyInYear: mappings.onlyInYear };
};
