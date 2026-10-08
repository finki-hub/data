// The courses-scraper's formula guard (app/export.py, _neutralize_formula):
// it writes a `'` before every text value whose start matches the Python
// pattern `\s*[=+\-@]`, in the CSV only. Google Sheets drops that `'` when
// the CSV is imported into the workbook, so the snapshot import drops it
// too, and both paths store the same value.

const codePoints = (first: number, last: number): readonly number[] =>
  Array.from({ length: last - first + 1 }, (_, index) => first + index);

// Python's \s on text (str.isspace), which differs from JavaScript's \s:
// it includes U+001C to U+001F and U+0085, and not U+FEFF.
const pythonSpaces: ReadonlySet<number> = new Set([
  ...codePoints(0x09, 0x0d),
  ...codePoints(0x1c, 0x20),
  0x85,
  0xa0,
  0x16_80,
  ...codePoints(0x20_00, 0x20_0a),
  0x20_28,
  0x20_29,
  0x20_2f,
  0x20_5f,
  0x30_00,
]);

const formulaStarts: ReadonlySet<string> = new Set(['+', '-', '=', '@']);

// The value without the guard: its leading `'` goes when optional Python
// whitespace and one of = + - @ follow it. Every other value, one with a
// `'` anywhere else included, stays as written.
export const withoutFormulaGuard = (value: string): string => {
  if (!value.startsWith("'")) {
    return value;
  }
  let index = 1;
  while (pythonSpaces.has(value.codePointAt(index) ?? -1)) {
    index += 1;
  }
  return formulaStarts.has(value.charAt(index)) ? value.slice(1) : value;
};
