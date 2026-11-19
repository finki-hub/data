// Studio shows every name in Title Case: the first letter of each word is
// capitalized, the rest is kept as written (so "ECTS", "ID" or "e-mail"
// keep their inner letters). A word starts the label or follows a space,
// an opening parenthesis or a slash: "Duration (years)" reads
// "Duration (Years)". The model declares its labels as plain phrases.
const wordStart = /(?<before>^|[\s(/])(?<letter>\p{Lowercase_Letter})/gu;

export const titleCase = (label: string): string =>
  label.replaceAll(wordStart, (...match: unknown[]) => {
    const groups = match.at(-1) as { before: string; letter: string };
    return `${groups.before}${groups.letter.toUpperCase()}`;
  });
