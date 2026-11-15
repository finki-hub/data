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
// 2022/23 on (п lecture, ав exercises, c and e the English program's); the
// lesson keeps them apart from the subject. Other parentheses belong to the
// subject's name. They decide nothing: a teacher's position does.
export const classKinds: readonly string[] = [
  'п',
  'п+ав',
  'ав',
  'в',
  'аб',
  'лаб',
  'ав+лаб',
  'c',
  'e',
];

// The academic titles the older timetables put inside a teacher's name
// ("Трајанов д-р Димитар"), lowercase: left out when matching names.
export const academicTitles = ['д-р', 'м-р', 'dr', 'dr.', 'mr', 'mr.'] as const;

// The positions whose holders are professors; everyone else who teaches is
// an assistant.
export const professorPositions = [
  'Редовен професор',
  'Вонреден професор',
  'Доцент',
  'Насловен вонреден професор',
  'Визитинг професор',
  'Професор во пензија',
] as const;
