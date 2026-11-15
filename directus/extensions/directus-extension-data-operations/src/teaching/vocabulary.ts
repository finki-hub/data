// The vocabularies of the timetable import, declared once: the data model
// (src/data-model/teaching-collections.ts) and the import read them from
// here. Pure: it imports nothing.

export const timetableTerms = ['winter', 'summer'] as const;

export type TimetableTerm = (typeof timetableTerms)[number];

// How a lesson's subject or teacher matched: to a course or staff member
// (by name or through an alias), ignored by an alias without a target, or
// not at all (it needs an alias).
export const matchStates = ['matched', 'ignored', 'unmatched'] as const;

// How many of the latest main timetables courses.json reads its teaching
// staff from: three years of semesters.
export const publishedSemesters = 6;

export type MatchState = (typeof matchStates)[number];

// The class types a subject's trailing parentheses name, from summer
// 2022/23 on: a lecture type makes the teacher a professor, an exercise
// type an assistant. The English program's c and e say neither for sure,
// so its teachers' positions decide, as in a timetable without types.
// Other parentheses belong to the subject's name.
export const lectureKinds = ['п', 'п+ав'] as const;

export const exerciseKinds = ['ав', 'в', 'аб', 'лаб', 'ав+лаб'] as const;

export const unsureKinds = ['c', 'e'] as const;

export const classKinds: readonly string[] = [
  ...lectureKinds,
  ...exerciseKinds,
  ...unsureKinds,
];

// The positions whose holders count as professors in a timetable that
// names no class type.
export const professorPositions = [
  'Редовен професор',
  'Вонреден професор',
  'Доцент',
] as const;
