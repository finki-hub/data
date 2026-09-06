import { describe, expect, test } from 'vitest';

import { buildSearchQuery } from '../directus/extensions/directus-extension-course-search/src/endpoint.js';
import {
  courseCondition,
  profileUrl,
  splitHistory,
} from '../directus/extensions/directus-extension-course-search/src/history.js';
import { nativeFilter } from '../directus/extensions/directus-extension-course-search/src/native-filter.js';

describe('Course history boundaries', () => {
  test('preserves nonempty raw LF and CRLF history entries', () => {
    expect(splitHistory('A\r\nB\n\n C ')).toEqual(['A', 'B', ' C ']);
  });

  test('drops a trailing carriage return from the last raw entry', () => {
    expect(splitHistory('A\r\nB\r')).toEqual(['A', 'B']);
  });

  test('escapes SQL LIKE wildcards only in the pattern boundaries', () => {
    expect(courseCondition('A_B%')).toEqual({
      _or: [
        { Courses: { _eq: 'A_B%' } },
        { Courses: { _eq: 'A_B%\r' } },
        { Courses: { _starts_with: 'A\\_B\\%\n' } },
        { Courses: { _starts_with: 'A\\_B\\%\r\n' } },
        { Courses: { _ends_with: '\nA\\_B\\%' } },
        { Courses: { _ends_with: '\nA\\_B\\%\r' } },
        { Courses: { _contains: '\nA\\_B\\%\n' } },
        { Courses: { _contains: '\nA\\_B\\%\r\n' } },
      ],
    });
  });

  test('returns no entries for empty and missing histories', () => {
    expect(splitHistory('')).toEqual([]);
    expect(splitHistory(null)).toEqual([]);
    expect(splitHistory(undefined)).toEqual([]);
  });

  test('builds exact raw-entry include and exclude boundaries', () => {
    expect(courseCondition('A')).toEqual({
      _or: [
        { Courses: { _eq: 'A' } },
        { Courses: { _eq: 'A\r' } },
        { Courses: { _starts_with: 'A\n' } },
        { Courses: { _starts_with: 'A\r\n' } },
        { Courses: { _ends_with: '\nA' } },
        { Courses: { _ends_with: '\nA\r' } },
        { Courses: { _contains: '\nA\n' } },
        { Courses: { _contains: '\nA\r\n' } },
      ],
    });
    expect(courseCondition('A', true)).toEqual({
      _or: [
        { Courses: { _null: true } },
        {
          _and: [
            { Courses: { _neq: 'A' } },
            { Courses: { _neq: 'A\r' } },
            { Courses: { _nstarts_with: 'A\n' } },
            { Courses: { _nstarts_with: 'A\r\n' } },
            { Courses: { _nends_with: '\nA' } },
            { Courses: { _nends_with: '\nA\r' } },
            { Courses: { _ncontains: '\nA\n' } },
            { Courses: { _ncontains: '\nA\r\n' } },
          ],
        },
      ],
    });
  });

  test('allows only HTTP(S) profile links', () => {
    expect(profileUrl('https://profiles.example/Ada')).toBe(
      'https://profiles.example/Ada',
    );
    expect(profileUrl('https://profiles.example/Ada')).toBe(
      'https://profiles.example/Ada',
    );
    expect(profileUrl('HTTPS://profiles.example/Ada')).toBe(
      'HTTPS://profiles.example/Ada',
    );
    expect(profileUrl(['java', 'script:alert(1)'].join(''))).toBeUndefined();
    expect(profileUrl('data:text/html,unsafe')).toBeUndefined();
    expect(profileUrl('/profiles/Ada')).toBeUndefined();
    expect(profileUrl(null)).toBeUndefined();
  });
});

const nest = (levels: number): unknown => {
  let filter: unknown = { Name: { _eq: 'Ada' } };
  for (let level = 0; level < levels; level += 1) filter = { _and: [filter] };
  return filter;
};

describe('Native course-search filters', () => {
  test('preserves nested AND and OR filter meaning', () => {
    expect(
      nativeFilter.parse({
        _and: [
          { Name: { _icontains: 'Ada' } },
          {
            _or: [{ 'Courses Count': { _gte: 2 } }, { Mail: { _null: true } }],
          },
        ],
      }),
    ).toStrictEqual({
      _and: [
        { Name: { _icontains: 'Ada' } },
        {
          _or: [{ 'Courses Count': { _gte: 2 } }, { Mail: { _null: true } }],
        },
      ],
    });
  });

  test('preserves supported case-insensitive negative operators', () => {
    expect(
      nativeFilter.parse({
        Name: { _nicontains: 'Ada' },
        Profile_new: { _niends_with: '/Ada' },
      }),
    ).toStrictEqual({
      Name: { _nicontains: 'Ada' },
      Profile_new: { _niends_with: '/Ada' },
    });
  });

  test('rejects unknown operators', () => {
    expect(() => nativeFilter.parse({ Name: { _regex: '.*' } })).toThrow();
  });

  test('rejects deeply nested filters without exhausting the stack', () => {
    expect(nativeFilter.safeParse(nest(8)).success).toBeTruthy();
    expect(nativeFilter.safeParse(nest(40)).success).toBeFalsy();
    expect(() => nativeFilter.safeParse(nest(5_000))).not.toThrow();
    expect(nativeFilter.safeParse(nest(5_000)).success).toBeFalsy();
  });

  test('drops undefined optional operators before producing a Directus filter', () => {
    expect(
      nativeFilter.parse({ Name: { _eq: 'Ada', _neq: undefined } }),
    ).toStrictEqual({
      Name: { _eq: 'Ada' },
    });
  });
});

describe('Course history search query', () => {
  test('combines current native filters with exact raw-history boundaries', () => {
    const currentFilter = nativeFilter.parse({
      _or: [{ Name: { _icontains: 'Ada' } }, { Mail: { _null: true } }],
    });

    expect(
      buildSearchQuery({
        exclude: ['Archived'],
        filter: currentFilter,
        include: ['Algorithms'],
        search: 'priority',
      }),
    ).toStrictEqual({
      filter: {
        _and: [
          currentFilter,
          courseCondition('Algorithms'),
          courseCondition('Archived', true),
        ],
      },
      search: 'priority',
    });
  });
});
