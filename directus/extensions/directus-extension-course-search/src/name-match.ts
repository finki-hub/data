// Name search over Moodle users. Almost every name is in Macedonian
// Cyrillic, while people often type them in Latin, with or without
// diacritics. Both sides are folded to one Latin skeleton, so "stojcevski",
// "Stojčevski" and "Стојчевски" all read "stojcevski".

// Latin letters that stand for a Cyrillic one and lose it when their marks
// are stripped.
const latinLetters: Readonly<Record<string, string>> = {
  ć: 'kj',
  đ: 'gj',
};

const cyrillicLetters: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  ђ: 'gj',
  е: 'e',
  ж: 'zh',
  з: 'z',
  ѕ: 'dz',
  и: 'i',
  ј: 'j',
  к: 'k',
  л: 'l',
  љ: 'lj',
  м: 'm',
  н: 'n',
  њ: 'nj',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  ћ: 'kj',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  џ: 'dzh',
  ш: 'sh',
};

// Spellings that differ only in how a letter is written in Latin, folded
// to one. Applied in order, after the Cyrillic letters become Latin.
const foldings: ReadonlyArray<readonly [RegExp, string]> = [
  [/dzh/gu, 'dz'],
  [/ch/gu, 'c'],
  [/sh/gu, 's'],
  [/zh/gu, 'z'],
  [/gj/gu, 'g'],
  [/kj/gu, 'k'],
  [/lj/gu, 'l'],
  [/nj/gu, 'n'],
  [/w/gu, 'v'],
  [/q/gu, 'k'],
  [/x/gu, 'ks'],
  [/y/gu, 'j'],
];

const markedLatinLetters = /[ćđ]/gu;
const cyrillicLetter = /\p{Script=Cyrillic}/gu;
const combiningMarks = /\p{Mark}/gu;
const wordSeparators = /[^\p{Letter}\p{Number}]+/u;

// The folded words of a name or of a typed query.
export const nameWords = (text: null | string | undefined): string[] => {
  let folded = (text ?? '')
    .toLocaleLowerCase('mk')
    .replaceAll(markedLatinLetters, (letter) => latinLetters[letter] ?? letter)
    .normalize('NFD')
    .replaceAll(combiningMarks, '')
    .replaceAll(cyrillicLetter, (letter) => cyrillicLetters[letter] ?? letter);
  for (const [pattern, replacement] of foldings)
    folded = folded.replaceAll(pattern, () => replacement);
  return folded.split(wordSeparators).filter((word) => word.length > 0);
};

// A matcher for a typed query: every query word starts some word of the
// name, in any order. A query without words matches nothing.
export const nameMatcher = (
  query: string,
): ((name: null | string | undefined) => boolean) => {
  const wanted = nameWords(query);
  return (name) => {
    if (wanted.length === 0) return false;
    const words = nameWords(name);
    return wanted.every((prefix) =>
      words.some((word) => word.startsWith(prefix)),
    );
  };
};

// The part of a mail address before the @, where a student's address
// spells their name in Latin (name.surname@students...). The domain is
// left out: every student would match a query for it.
export const mailName = (mail: null | string | undefined): string => {
  const at = (mail ?? '').indexOf('@');
  return at > 0 ? (mail ?? '').slice(0, at) : '';
};
