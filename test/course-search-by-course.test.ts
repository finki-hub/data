import { describe, expect, test } from 'vitest';

import {
  criteriaProblem,
  criteriaSchema,
} from '../directus/extensions/directus-extension-course-search/src/criteria.js';
import {
  buildSearchQuery,
  matchedLinesQuery,
  optionNames,
  withMatchedLines,
} from '../directus/extensions/directus-extension-course-search/src/endpoint.js';
import {
  countedCourseCondition,
  courseCondition,
} from '../directus/extensions/directus-extension-course-search/src/history.js';

const countedFor = (course: string) => ({
  entry: { counted_for: { course: { name: { _eq: course } } } },
});

describe('Search by course', () => {
  test('matches a course through the lines the count counted for it', () => {
    expect(countedCourseCondition('Дискретни структури 1')).toEqual({
      history_memberships: countedFor('Дискретни структури 1'),
    });
    expect(countedCourseCondition('Алгоритми', true)).toEqual({
      history_memberships: { _none: countedFor('Алгоритми') },
    });
  });

  test('builds the query of either mode, by Moodle course name without one', () => {
    const criteria = { exclude: ['B'], include: ['A'], search: 'Ana' };

    expect(buildSearchQuery({ ...criteria, match: 'course' })).toEqual({
      filter: {
        _and: [countedCourseCondition('A'), countedCourseCondition('B', true)],
      },
      search: 'Ana',
    });
    expect(buildSearchQuery(criteria)).toEqual({
      filter: { _and: [courseCondition('A'), courseCondition('B', true)] },
      search: 'Ana',
    });
  });

  test('takes the mode from the criteria, Moodle course name by default', () => {
    const base = { exclude: [], include: [], page: 1 };

    expect(criteriaSchema.parse(base).match).toBe('line');
    expect(criteriaSchema.parse({ ...base, match: 'course' }).match).toBe(
      'course',
    );

    const { error } = criteriaSchema.safeParse({ ...base, match: 'staff' });

    expect(error && criteriaProblem(error)).toBe(
      'Invalid criteria: match: expected course or line',
    );
  });

  test('reads the memberships of the picked courses only when matching by course', () => {
    expect(matchedLinesQuery({ include: ['A', 'B'], match: 'course' })).toEqual(
      {
        deep: {
          history_memberships: {
            _filter: {
              entry: {
                counted_for: { course: { name: { _in: ['A', 'B'] } } },
              },
            },
            _limit: -1,
          },
        },
        fields: expect.arrayContaining([
          'Courses',
          'history_memberships.entry.label',
        ]) as unknown,
      },
    );
    expect(
      matchedLinesQuery({ include: [], match: 'course' }),
    ).not.toHaveProperty('deep');
    expect(
      matchedLinesQuery({ include: ['A'], match: 'line' }).fields,
    ).not.toContain('history_memberships.entry.label');
  });

  test('marks the matched lines in history order and drops the memberships', () => {
    const row = {
      Courses: 'Дискретна математика 1\nПрограмирање\nDiscrete Mathematics 1',
      history_memberships: [
        { entry: { label: 'Discrete Mathematics 1' } },
        { entry: { label: 'Дискретна математика 1' } },
        { entry: null },
      ],
      id: 7,
      Name: 'Ana',
    };

    expect(
      withMatchedLines([row], {
        include: ['Дискретни структури 1'],
        match: 'course',
      }),
    ).toEqual([
      {
        Courses: row.Courses,
        id: 7,
        matched: ['Дискретна математика 1', 'Discrete Mathematics 1'],
        Name: 'Ana',
      },
    ]);
    expect(
      withMatchedLines([{ Courses: row.Courses, id: 8 }], {
        include: ['Програмирање', 'Absent'],
        match: 'line',
      }),
    ).toEqual([{ Courses: row.Courses, id: 8, matched: ['Програмирање'] }]);
  });

  test('offers the courses with counted lines, or every history line', async () => {
    const queries: unknown[] = [];
    const courses = await optionNames((query) => {
      queries.push(query);
      return Promise.resolve([{ name: 'B' }, { name: 'A' }, { name: null }]);
    }, 'course');

    expect([...courses]).toEqual(['B', 'A']);
    expect(queries).toEqual([
      {
        fields: ['name'],
        filter: { counted_lines: { id: { _nnull: true } } },
        limit: -1,
      },
    ]);

    const lines = await optionNames(
      () => Promise.resolve([{ Courses: 'X\nY' }, { Courses: 'Y\r\nZ' }]),
      'line',
    );

    expect([...lines]).toEqual(['X', 'Y', 'Z']);
  });
});
