import type { Query } from '@directus/types';

import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { SourceRead } from '../directus/extensions/directus-extension-data-operations/src/exports/types.js';

import { courses } from '../directus/extensions/directus-extension-data-operations/src/exports/courses.js';
import {
  readQuery,
  wholeNested,
} from '../directus/extensions/directus-extension-data-operations/src/exports/directus.js';

// The native query of every export read. Unless the deep query names
// `_limit` at a step, Directus 12.3.1 cuts the list of an O2M or M2M step
// under each row to QUERY_LIMIT_DEFAULT, before sorting the list
// (merge-with-parent-items.js), so program states would go missing.

// A QUERY_LIMIT_DEFAULT below the number of programs of a generation.
const defaultLimit = 2;

const level = z.record(z.string(), z.unknown());

// The `_limit` a deep query sets at a path of field steps.
const limitAt = (
  deep: unknown,
  path: readonly string[],
): number | undefined => {
  let step = deep;
  for (const field of path) {
    step = level.safeParse(step).data?.[field];
  }
  return z.object({ _limit: z.number() }).safeParse(step).data?._limit;
};

// The program states of an entry as a Directus with that default limit
// answers them for the query: the list under the linked entry, cut.
const statesAnswered = (query: Query, list: readonly unknown[]) => {
  const limit =
    limitAt(query.deep, ['entry', 'program_states']) ?? defaultLimit;
  return limit === -1 ? list : list.slice(0, limit);
};

const relatedRead = (key: string): SourceRead => {
  const read = courses.related[key];
  if (read === undefined) {
    throw new Error(`courses.json reads no ${key}`);
  }
  return read;
};

const states = [
  { program: 1, state: 'A' },
  { program: 2, state: 'B' },
  { program: 3, state: 'C' },
];

describe('the native query of an export read', () => {
  test('reads every relational step of its fields whole', () => {
    expect(
      wholeNested([
        ['course'],
        ['entry', 'name'],
        ['entry', 'program_states', 'program'],
        ['entry', 'program_states', 'state'],
        ['staff', 'name'],
      ]),
    ).toEqual({
      entry: { _limit: -1, program_states: { _limit: -1 } },
      staff: { _limit: -1 },
    });
  });

  test("keeps every program state of a course's linked entry above the default limit", () => {
    const query = readQuery(relatedRead('curricula'));

    expect(query).toMatchObject({
      deep: { entry: { _limit: -1, program_states: { _limit: -1 } } },
      limit: -1,
    });
    expect(statesAnswered(query, states)).toEqual(states);
    // Without the deep query the default limit would drop a state.
    expect(statesAnswered({ ...query, deep: null }, states)).toHaveLength(
      defaultLimit,
    );
  });

  test('adds no deep query to a read of plain fields, and none to an aggregate', () => {
    expect(readQuery(courses.rows)).toEqual({
      fields: ['id', 'name', 'tags', 'professors_override'],
      limit: -1,
      sort: ['id'],
    });
    expect(
      readQuery({
        aggregate: 'count',
        collection: 'courses',
        fields: ['id'],
        filter: { name: { _nnull: true } },
        sort: [],
      }),
    ).toEqual({
      aggregate: { count: ['id'] },
      filter: { name: { _nnull: true } },
    });
  });
});
