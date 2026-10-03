import type { Filter, Query } from '@directus/types';

import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import {
  type ItemsReader,
  pageSegments,
  readPage,
  type SearchSort,
} from '../directus/extensions/directus-extension-course-search/src/count-order.js';
import {
  countText,
  rangeText,
} from '../directus/extensions/directus-extension-course-search/src/count-text.js';
import {
  criteriaProblem,
  criteriaSchema,
  invalidCriteria,
} from '../directus/extensions/directus-extension-course-search/src/criteria.js';
import { buildSearchQuery } from '../directus/extensions/directus-extension-course-search/src/endpoint.js';
import { failureText } from '../directus/extensions/directus-extension-course-search/src/failure-text.js';
import {
  filterPathProblem,
  relationalDepthLimit,
} from '../directus/extensions/directus-extension-course-search/src/filter-paths.js';
import {
  courseCondition,
  profileUrl,
  splitHistory,
} from '../directus/extensions/directus-extension-course-search/src/history.js';
import {
  courseLimit,
  pageSize,
} from '../directus/extensions/directus-extension-course-search/src/limits.js';
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

  test('preserves the relational paths Studio writes for a related field', () => {
    const studio = {
      _and: [
        {
          history_memberships: { entry: { label: { _contains: 'Networks' } } },
        },
        {
          history_memberships: {
            entry: { mappings: { course: { name: { _eq: 'Algorithms' } } } },
          },
        },
        { 'count(history_memberships)': { _gt: 2 } },
      ],
    };

    expect(nativeFilter.parse(studio)).toStrictEqual(studio);
    expect(
      nativeFilter.parse({
        history_memberships: {
          entry: { label: { _eq: 'A', _neq: undefined } },
        },
      }),
    ).toStrictEqual({
      history_memberships: { entry: { label: { _eq: 'A' } } },
    });
  });

  test.each([
    [
      'a _some quantifier',
      { history_memberships: { _some: { entry: { id: { _eq: 1 } } } } },
    ],
    [
      'a _none quantifier',
      { history_memberships: { _none: { entry: { id: { _eq: 1 } } } } },
    ],
    [
      'a group inside a relational path',
      { history_memberships: { _and: [{ entry: { id: { _eq: 1 } } }] } },
    ],
    [
      'an unknown operator at the end of a path',
      { history_memberships: { entry: { label: { _regex: '.*' } } } },
    ],
    [
      'operators mixed with a relational field',
      { history_memberships: { _null: true, entry: { id: { _eq: 1 } } } },
    ],
    ['an operator where a field belongs', { _unknown: { _eq: 1 } }],
    [
      'an implicit $FOLLOW relation inside a path',
      {
        history_memberships: {
          entry: {
            '$FOLLOW(moodle_history_memberships, entry)': {
              moodle_user: { Courses: { _contains: 'Hidden' } },
            },
          },
        },
      },
    ],
    [
      'an implicit $FOLLOW relation at the root',
      {
        '$FOLLOW(moodle_history_memberships, moodle_user)': {
          entry: { label: { _eq: 'Hidden' } },
        },
      },
    ],
    [
      'an implicit relation inside a function',
      { 'count($FOLLOW(moodle_history_memberships, entry))': { _gt: 1 } },
    ],
  ])('rejects %s', (_label, filter) => {
    expect(nativeFilter.safeParse(filter).success).toBeFalsy();
  });

  test('drops undefined optional operators before producing a Directus filter', () => {
    expect(
      nativeFilter.parse({ Name: { _eq: 'Ada', _neq: undefined } }),
    ).toStrictEqual({
      Name: { _eq: 'Ada' },
    });
  });
});

// A filter naming `fields` fields along a chain next -> next -> ...
const chain = (fields: number): unknown => {
  let filter: unknown = { value: { _eq: 1 } };
  for (let field = 1; field < fields; field += 1) filter = { next: filter };
  return filter;
};

describe('Search filter paths', () => {
  test('accept the paths Studio writes', () => {
    for (const filter of [
      { history_memberships: { entry: { label: { _contains: 'A' } } } },
      {
        _and: [
          {
            history_memberships: {
              entry: { mappings: { course: { name: { _eq: 'Algorithms' } } } },
            },
          },
          { 'count(history_memberships)': { _gt: 2 } },
        ],
      },
      { history_memberships: { moodle_user: { Mail: { _nnull: true } } } },
      { Name: { _eq: 'Ada' } },
    ]) {
      expect(filterPathProblem(filter, 10)).toBeUndefined();
    }
  });

  test('name at most as many fields as the REST depth limit allows', () => {
    expect(filterPathProblem(chain(10), 10)).toBeUndefined();
    expect(filterPathProblem(chain(11), 10)).toBe('path exceeds 10 fields');
    expect(
      filterPathProblem({ _and: [{ value: { _eq: 1 } }, chain(11)] }, 10),
    ).toBe('path exceeds 10 fields');
  });

  test('take Directus own limit, never below two fields', () => {
    expect(relationalDepthLimit({ MAX_RELATIONAL_DEPTH: 10 })).toBe(10);
    expect(relationalDepthLimit({ MAX_RELATIONAL_DEPTH: '4' })).toBe(4);
    expect(relationalDepthLimit({ MAX_RELATIONAL_DEPTH: 1 })).toBe(2);
    expect(relationalDepthLimit({})).toBe(2);
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

type SyntheticUser = {
  readonly 'Courses Count': null | number;
  readonly id: number;
  readonly Name: string;
};

// A caller-scoped ItemsService stand-in over synthetic users: it applies
// the count segment the page adds to the search filter, sorts like
// PostgreSQL (NULL last ascending, first descending) and records every
// query it was given.
const syntheticItems = (users: readonly SyntheticUser[]) => {
  const queries: Query[] = [];
  // The count segment readPage adds to the caller's filter, if any.
  const segment = (filter: Filter | null | undefined) => {
    const text = JSON.stringify(filter ?? {});
    return (user: SyntheticUser) => {
      if (text.includes('"_nnull":true')) {
        return user['Courses Count'] !== null;
      }
      return text.includes('"_null":true')
        ? user['Courses Count'] === null
        : true;
    };
  };
  const value = (user: SyntheticUser, field: string) => {
    if (field === 'Name') {
      return user.Name;
    }
    return field === 'id' ? user.id : user['Courses Count'];
  };
  const compare =
    (sort: readonly string[]) =>
    (left: SyntheticUser, right: SyntheticUser): number => {
      for (const key of sort) {
        const descending = key.startsWith('-');
        const field = descending ? key.slice(1) : key;
        const [a, b] = [value(left, field), value(right, field)];
        if (a === b) {
          continue;
        }
        if (a === null || b === null) {
          return (a === null) === descending ? -1 : 1;
        }
        return a < b === descending ? 1 : -1;
      }
      return 0;
    };
  const reader: ItemsReader = {
    readByQuery: async (query) => {
      queries.push(query);
      const matching = users.filter(segment(query.filter));
      if (query.aggregate !== undefined && query.aggregate !== null) {
        return [{ count: { id: String(matching.length) } }];
      }
      const offset = query.offset ?? 0;
      return matching
        .toSorted(compare(query.sort ?? []))
        .slice(offset, offset + (query.limit ?? 0));
    },
  };
  return { queries, reader };
};

const syntheticUsers: SyntheticUser[] = Array.from(
  { length: 105 },
  (_, index) => ({
    'Courses Count': index % 7 === 0 || index >= 90 ? null : index % 4,
    id: index + 1,
    Name: `Synthetic ${String(105 - index).padStart(3, '0')}`,
  }),
);

const syntheticCollator = new Intl.Collator('en');

const byName = (left: SyntheticUser, right: SyntheticUser): number =>
  syntheticCollator.compare(left.Name, right.Name) || left.id - right.id;

const everyPage = async (
  users: readonly SyntheticUser[],
  sort: SearchSort,
): Promise<unknown[]> => {
  const { reader } = syntheticItems(users);
  const pages: unknown[] = [];
  for (let page = 1; page <= Math.ceil(users.length / pageSize); page += 1) {
    const rows = await readPage(reader, {
      fields: ['id', 'Name', 'Courses Count'],
      page,
      query: { filter: { _and: [] } },
      sort,
    });

    expect(rows).toHaveLength(
      Math.min(pageSize, users.length - (page - 1) * pageSize),
    );

    pages.push(...rows);
  }
  return pages;
};

describe('Course history count order', () => {
  test('splits a page between the counted and the uncounted users', () => {
    expect(pageSegments(1, 60)).toEqual({
      counted: { limit: 50, offset: 0 },
      uncounted: { limit: 0, offset: 0 },
    });
    expect(pageSegments(2, 60)).toEqual({
      counted: { limit: 10, offset: 50 },
      uncounted: { limit: 40, offset: 0 },
    });
    expect(pageSegments(3, 60)).toEqual({
      counted: { limit: 0, offset: 100 },
      uncounted: { limit: 50, offset: 40 },
    });
    expect(pageSegments(1, 0)).toEqual({
      counted: { limit: 0, offset: 0 },
      uncounted: { limit: 50, offset: 0 },
    });
  });

  test('ranks users without a stored count after every counted user in both directions', async () => {
    const counted = syntheticUsers.filter(
      (user) => user['Courses Count'] !== null,
    );
    const uncounted = syntheticUsers
      .filter((user) => user['Courses Count'] === null)
      .toSorted(byName);

    await expect(everyPage(syntheticUsers, '-Courses Count')).resolves.toEqual([
      ...counted.toSorted(
        (left, right) =>
          (right['Courses Count'] ?? 0) - (left['Courses Count'] ?? 0) ||
          byName(left, right),
      ),
      ...uncounted,
    ]);
    await expect(everyPage(syntheticUsers, 'Courses Count')).resolves.toEqual([
      ...counted.toSorted(
        (left, right) =>
          (left['Courses Count'] ?? 0) - (right['Courses Count'] ?? 0) ||
          byName(left, right),
      ),
      ...uncounted,
    ]);
  });

  test('reads through the caller query with the count segment added and the name order unchanged', async () => {
    const { queries, reader } = syntheticItems(syntheticUsers);
    const base: Filter = { Name: { _starts_with: 'Synthetic' } };
    await readPage(reader, {
      fields: ['id'],
      page: 2,
      query: { filter: base, search: 'synthetic' },
      sort: '-Courses Count',
    });

    expect(queries).toEqual([
      {
        aggregate: { count: ['id'] },
        filter: { _and: [base, { 'Courses Count': { _nnull: true } }] },
        search: 'synthetic',
      },
      {
        fields: ['id'],
        filter: { _and: [base, { 'Courses Count': { _nnull: true } }] },
        limit: 27,
        offset: 50,
        search: 'synthetic',
        sort: ['-Courses Count', 'Name', 'id'],
      },
      {
        fields: ['id'],
        filter: { _and: [base, { 'Courses Count': { _null: true } }] },
        limit: 23,
        offset: 0,
        search: 'synthetic',
        sort: ['Name', 'id'],
      },
    ]);

    queries.length = 0;
    await readPage(reader, {
      fields: ['id'],
      page: 1,
      query: { filter: base },
      sort: 'Name',
    });

    expect(queries).toEqual([
      {
        fields: ['id'],
        filter: base,
        limit: 50,
        offset: 0,
        sort: ['Name', 'id'],
      },
    ]);
  });
});

describe('Search count labels', () => {
  test('use the singular for exactly one and the plural otherwise', () => {
    expect(countText(1, 'course', 'courses')).toBe('1 course');
    expect(countText(0, 'course', 'courses')).toBe('0 courses');
    expect(countText(2, 'matching user', 'matching users')).toBe(
      '2 matching users',
    );
    expect(countText(1, 'matching user', 'matching users')).toBe(
      '1 matching user',
    );
    expect(countText(1_234, 'course', 'courses')).toBe(
      `${(1_234).toLocaleString()} courses`,
    );
  });

  test('localize every number of the page range', () => {
    expect(pageSize).toBe(50);
    expect(rangeText(1, 7)).toBe('1–7 of 7');
    expect(rangeText(21, 1_234)).toBe(
      `${(1_001).toLocaleString()}–${(1_050).toLocaleString()} of ${(1_234).toLocaleString()}`,
    );
  });
});

const refusal = (body: unknown): string => {
  const parsed = criteriaSchema.safeParse(body);
  if (parsed.success) throw new Error('the criteria were accepted');
  return criteriaProblem(parsed.error);
};

const nested = (depth: number): unknown =>
  JSON.parse(`${'{"a":'.repeat(depth)}{"_eq":1}${'}'.repeat(depth)}`);

const answered = (status: number, errors?: unknown) => ({
  response: { data: errors === undefined ? undefined : { errors }, status },
});

describe('Search refusals', () => {
  const base = { exclude: [], include: [], page: 1 };

  test.each([
    [
      'too many courses',
      {
        ...base,
        include: Array.from(
          { length: courseLimit + 1 },
          (_, index) => `C${String(index)}`,
        ),
      },
      'Invalid criteria: include: max 20 courses',
    ],
    [
      'an empty course name',
      { ...base, exclude: [''] },
      'Invalid criteria: exclude.0: empty',
    ],
    [
      'a missing course list',
      { exclude: [], page: 1 },
      'Invalid criteria: include: expected a list of course names',
    ],
    [
      'page 0',
      { ...base, page: 0 },
      'Invalid criteria: page: expected an integer >= 1',
    ],
    [
      'an unknown sort',
      { ...base, sort: 'Mail' },
      'Invalid criteria: sort: expected Name, Courses Count or -Courses Count',
    ],
    [
      'a long search',
      { ...base, search: 'x'.repeat(1_001) },
      'Invalid criteria: search: max 1000 characters',
    ],
    [
      'an unknown operator',
      { ...base, filter: { Name: { _regex: '.*' } } },
      'Invalid criteria: filter: unsupported key _regex',
    ],
    [
      'an implicit relation',
      {
        ...base,
        filter: {
          '$FOLLOW(moodle_history_memberships, moodle_user)': {
            entry: { label: { _eq: 'Hidden' } },
          },
        },
      },
      'Invalid criteria: filter: unsupported key $FOLLOW(moodle_history_memberships, moodle_user)',
    ],
    [
      'a condition of another shape',
      { ...base, filter: { Name: 5 } },
      'Invalid criteria: filter: unsupported condition',
    ],
    [
      'a deep filter',
      { ...base, filter: nested(40) },
      'Invalid criteria: filter: nesting exceeds 24 levels',
    ],
    ['a body that is no object', 'x', 'Invalid criteria: expected an object'],
    [
      'two faults',
      { ...base, page: 0, sort: 'Mail' },
      'Invalid criteria: page: expected an integer >= 1 (+1 more)',
    ],
  ])('name the field and the reason of %s', (_label, body, expected) => {
    expect(refusal(body)).toBe(expected);
  });

  test('place a refused filter path after the filter', () => {
    expect(invalidCriteria('filter', 'path exceeds 10 fields')).toBe(
      'Invalid criteria: filter: path exceeds 10 fields',
    );
  });
});

describe('Search failure lines', () => {
  test('name the status and code, and the server message unless refused', () => {
    expect(
      failureText(
        'Search',
        answered(403, [
          {
            extensions: { code: 'FORBIDDEN' },
            message: "You don't have permission to access this.",
          },
        ]),
      ),
    ).toBe('Search failed: HTTP 403 FORBIDDEN');
    expect(
      failureText(
        'Search',
        answered(400, [
          {
            extensions: { code: 'INVALID_PAYLOAD' },
            message: 'Invalid criteria: filter: path exceeds 10 fields',
          },
        ]),
      ),
    ).toBe(
      'Search failed: HTTP 400 INVALID_PAYLOAD: Invalid criteria: filter: path exceeds 10 fields',
    );
    expect(failureText('Search', answered(502))).toBe(
      'Search failed: HTTP 502',
    );
  });

  test('say when nothing answered or the answer has another shape', () => {
    expect(failureText('Course list', new Error('Network Error'))).toBe(
      'Course list failed: no response',
    );

    const shape = z.object({ total: z.number() }).safeParse({});

    expect(shape.success).toBeFalsy();
    expect(failureText('Search', shape.error)).toBe(
      'Search failed: invalid response',
    );
  });
});
