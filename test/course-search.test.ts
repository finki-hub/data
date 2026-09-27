import type { Filter, Query } from '@directus/types';

import { describe, expect, test } from 'vitest';

import {
  type ItemsReader,
  pageSegments,
  pageSize,
  readPage,
  type SearchSort,
} from '../directus/extensions/directus-extension-course-search/src/count-order.js';
import { countText } from '../directus/extensions/directus-extension-course-search/src/count-text.js';
import { buildSearchQuery } from '../directus/extensions/directus-extension-course-search/src/endpoint.js';
import {
  filterPathProblem,
  type PathRelation,
  relationalDepthLimit,
} from '../directus/extensions/directus-extension-course-search/src/filter-paths.js';
import {
  courseCondition,
  profileUrl,
  splitHistory,
} from '../directus/extensions/directus-extension-course-search/src/history.js';
import { nativeFilter } from '../directus/extensions/directus-extension-course-search/src/native-filter.js';
import {
  modelRelations,
  toRelationPayload,
} from '../src/data-model/relations.js';

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

// The relations setup installs, as Directus reports them.
const installed: readonly PathRelation[] =
  modelRelations.map(toRelationPayload);
const searchRules = {
  maxDepth: 10,
  relations: installed,
  root: 'moodle_users',
};

// A synthetic chain c0.next -> c1 -> ... in which no collection repeats,
// and a filter naming `fields` fields along it.
const chainRelations: readonly PathRelation[] = Array.from(
  { length: 16 },
  (_, index) => ({
    collection: `c${String(index)}`,
    field: 'next',
    meta: null,
    related_collection: `c${String(index + 1)}`,
  }),
);
const chain = (fields: number): unknown => {
  let filter: unknown = { value: { _eq: 1 } };
  for (let field = 1; field < fields; field += 1) filter = { next: filter };
  return filter;
};

describe('Search filter paths', () => {
  test('accept the paths Studio writes through the caller own memberships', () => {
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
      { Name: { _eq: 'Ada' } },
    ]) {
      expect(filterPathProblem(filter, searchRules)).toBeUndefined();
    }
  });

  test.each([
    [
      'from an entry back to every membership of it',
      {
        history_memberships: {
          entry: {
            memberships: { moodle_user: { Courses: { _nnull: true } } },
          },
        },
      },
      'moodle_history_memberships',
    ],
    [
      'from a membership back to a Moodle user',
      { history_memberships: { moodle_user: { Mail: { _nnull: true } } } },
      'moodle_users',
    ],
    [
      'through a count of an entry memberships',
      { history_memberships: { entry: { 'count(memberships)': { _gt: 1 } } } },
      'moodle_history_memberships',
    ],
    [
      'inside an _or group',
      {
        _or: [
          { Name: { _eq: 'Ada' } },
          { history_memberships: { moodle_user: { Name: { _eq: 'Bo' } } } },
        ],
      },
      'moodle_users',
    ],
  ])('refuse a path %s', (_label, filter, collection) => {
    expect(filterPathProblem(filter, searchRules)).toBe(
      `A filter path passes ${collection} twice`,
    );
  });

  test('name at most as many fields as the REST depth limit allows', () => {
    const rules = { maxDepth: 10, relations: chainRelations, root: 'c0' };

    expect(filterPathProblem(chain(10), rules)).toBeUndefined();
    expect(filterPathProblem(chain(11), rules)).toBe(
      'A filter path names at most 10 fields',
    );
    expect(
      filterPathProblem({ _and: [{ value: { _eq: 1 } }, chain(11)] }, rules),
    ).toBe('A filter path names at most 10 fields');
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
});
