import type { Filter } from '@directus/types';

const historySeparator = /\r?\n/u;
const trailingCarriageReturn = /\r$/u;
const likeMetacharacters = /[\\%_]/gu;
const httpUrl = /^https?:\/\//iu;

export const splitHistory = (history: null | string | undefined): string[] =>
  (history ?? '')
    .split(historySeparator)
    .map((line) => line.replace(trailingCarriageReturn, ''))
    .filter((line) => line.length > 0);

// Directus passes pattern operators to SQL LIKE unescaped, so the wildcard
// characters of a raw course label are escaped to keep boundaries exact.
const likePattern = (value: string): string =>
  value.replaceAll(likeMetacharacters, String.raw`\$&`);

export const courseCondition = (course: string, excluded = false): Filter => {
  const pattern = likePattern(course);
  const boundaries = [
    ['_eq', course],
    ['_eq', `${course}\r`],
    ['_starts_with', `${pattern}\n`],
    ['_starts_with', `${pattern}\r\n`],
    ['_ends_with', `\n${pattern}`],
    ['_ends_with', `\n${pattern}\r`],
    ['_contains', `\n${pattern}\n`],
    ['_contains', `\n${pattern}\r\n`],
  ] as const;
  if (!excluded) {
    return {
      _or: boundaries.map(([operator, value]) => ({
        Courses: { [operator]: value },
      })),
    };
  }
  const inverse = {
    _contains: '_ncontains',
    _ends_with: '_nends_with',
    _eq: '_neq',
    _starts_with: '_nstarts_with',
  } as const;
  return {
    _or: [
      { Courses: { _null: true } },
      {
        _and: boundaries.map(([operator, value]) => ({
          Courses: { [inverse[operator]]: value },
        })),
      },
    ],
  };
};

// A user's history lines that the last count counted for a course of this
// name, in any academic year: every name variant, English name and Moodle
// course link the counting maps to it.
const countedFor = (course: string) => ({
  entry: { counted_for: { course: { name: { _eq: course } } } },
});

export const countedCourseCondition = (
  course: string,
  excluded = false,
): Filter =>
  excluded
    ? { history_memberships: { _none: countedFor(course) } }
    : { history_memberships: countedFor(course) };

// Only the memberships whose line counts for one of these courses.
export const countedForAny = (courses: readonly string[]): Filter => ({
  entry: { counted_for: { course: { name: { _in: [...courses] } } } },
});

export const profileUrl = (
  value: null | string | undefined,
): string | undefined => (value && httpUrl.test(value) ? value : undefined);
