// The curriculum level of a FINKI subject code, declared once: the digit
// after `F`, the two generation digits and `L` at the start of the code
// (F18L3W055 is level 3). Only that start is read: F18L3S07, with a
// two-digit serial, is level 3, and the generation digits are not compared
// with the entry's generation. The import refuses a non-empty code without
// that start (curriculum_code_without_level), courses.json publishes
// `<generation>-level` from it, and the database guard of
// curriculum-guards.ts states the same start in SQL, `^F[0-9]{2}L[0-9]`.

const levelStart = /^F\d{2}L(?<level>\d)/u;

// The level a code gives, or null for a null or empty code and for a code
// without the `F<yy>L<level>` start.
export const codeLevel = (code: null | string | undefined): null | number => {
  const level = levelStart.exec(code ?? '')?.groups?.['level'];
  return level === undefined ? null : Number(level);
};
