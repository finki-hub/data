import type { Filter } from '@directus/types';

export const splitHistory = (history: string | null | undefined): string[] =>
  (history ?? '').split(/\r?\n/u).filter((line) => line.length > 0);

export const courseCondition = (course: string, excluded = false): Filter => {
  const boundaries = [
    ['_eq', course],
    ['_eq', `${course}\r`],
    ['_starts_with', `${course}\n`],
    ['_starts_with', `${course}\r\n`],
    ['_ends_with', `\n${course}`],
    ['_ends_with', `\n${course}\r`],
    ['_contains', `\n${course}\n`],
    ['_contains', `\n${course}\r\n`],
  ] as const;
  if (!excluded) {
    return { _or: boundaries.map(([operator, value]) => ({ Courses: { [operator]: value } })) };
  }
  const inverse = {
    _eq: '_neq',
    _starts_with: '_nstarts_with',
    _ends_with: '_nends_with',
    _contains: '_ncontains',
  } as const;
  return {
    _or: [
      { Courses: { _null: true } },
      { _and: boundaries.map(([operator, value]) => ({ Courses: { [inverse[operator]]: value } })) },
    ],
  };
};

export const profileUrl = (value: string | null | undefined): string | undefined =>
  value && /^https?:\/\//iu.test(value) ? value : undefined;
