import { z } from 'zod';

import { classKinds, type TimetableTerm } from './vocabulary.js';

// What the import reads from timetables-api.finki-hub.com: the listing and,
// of each timetable, the subject, teachers and length of every card. Pure.

export const listingSchema = z.array(
  z.object({
    dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    hidden: z.boolean(),
    id: z.string().regex(/^\d+$/u),
    title: z.string().min(1),
  }),
);

export type ListedTimetable = z.infer<typeof listingSchema>[number];

const namedSchema = z.object({ name: z.string() });

export const timetableSchema = z.object({
  cards: z.array(
    z.object({
      durationPeriods: z.number().int().nonnegative(),
      subject: namedSchema,
      teachers: z.array(namedSchema),
    }),
  ),
});

export type Timetable = z.infer<typeof timetableSchema>;

const spaces = /\s+/gu;

const tidy = (text: string): string => text.replaceAll(spaces, ' ').trim();

export type SplitSubject = {
  readonly kind: null | string;
  readonly subject: string;
};

// A subject's trailing class type, such as "(п)" or "(ав)", with or
// without a space before it. Other parentheses ("(и безбедност)") belong
// to the name.
export const splitSubject = (name: string): SplitSubject => {
  const text = tidy(name);
  const open = text.lastIndexOf('(');
  const kind = text.endsWith(')') && open > 0 ? text.slice(open + 1, -1) : '';
  const subject = text.slice(0, open).trimEnd();
  return classKinds.includes(kind.trim()) && subject !== ''
    ? { kind: kind.trim(), subject }
    : { kind: null, subject: text };
};

export type Semester = {
  // The academic year's label, such as 2026/2027.
  readonly academicYear: string;
  readonly term: TimetableTerm;
};

// A timetable starting from August on belongs to the winter semester of
// the academic year starting that year, one from January to July to the
// summer semester of the year that started the year before.
export const semesterOf = (dateFrom: string): Semester => {
  const year = Number(dateFrom.slice(0, 4));
  const month = Number(dateFrom.slice(5, 7));
  const start = month >= 8 ? year : year - 1;
  return {
    academicYear: `${String(start)}/${String(start + 1)}`,
    term: month >= 8 || month === 1 ? 'winter' : 'summer',
  };
};

// The ids of the main timetables: the one that starts last in each
// semester (the earlier ones cover its first weeks), the higher id on a
// tie.
export const mainTimetables = (
  listed: readonly ListedTimetable[],
): ReadonlySet<string> => {
  const latest = new Map<string, ListedTimetable>();
  for (const timetable of listed) {
    const { academicYear, term } = semesterOf(timetable.dateFrom);
    const key = `${academicYear} ${term}`;
    const current = latest.get(key);
    if (
      current === undefined ||
      timetable.dateFrom > current.dateFrom ||
      (timetable.dateFrom === current.dateFrom &&
        Number(timetable.id) > Number(current.id))
    ) {
      latest.set(key, timetable);
    }
  }
  return new Set(latest.values().map(({ id }) => id));
};

export type Lesson = {
  readonly kind: null | string;
  readonly periods: number;
  readonly subject: string;
  readonly teacher: string;
};

// A timetable's lessons: the weekly periods of every subject, class type
// and teacher, summed over its cards; a card without a teacher counts for
// none.
export const lessonsOf = (timetable: Timetable): Lesson[] => {
  const lessons = new Map<string, Lesson>();
  for (const card of timetable.cards) {
    const { kind, subject } = splitSubject(card.subject.name);
    for (const { name } of card.teachers) {
      const teacher = tidy(name);
      if (teacher === '' || subject === '') {
        continue;
      }
      const key = JSON.stringify([subject, kind, teacher]);
      const periods = (lessons.get(key)?.periods ?? 0) + card.durationPeriods;
      lessons.set(key, { kind, periods, subject, teacher });
    }
  }
  return lessons.values().toArray();
};
