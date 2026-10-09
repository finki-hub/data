import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { CourseCandidate } from '../src/import/candidates.js';

import {
  registerCourseDefaultMapping,
  withDefaultMapping,
} from '../directus/extensions/directus-extension-data-operations/src/course-default-mapping.js';
import {
  defaultPattern,
  defaultYearPattern,
} from '../directus/extensions/directus-extension-data-operations/src/enrollment-lines.js';
import { planPatternMappings } from '../src/import/pattern-mappings.js';
import { postedRecord } from '../src/import/write.js';

const name = 'C++ (напредно)';

const defaultMapping = {
  pattern: String.raw`C\+\+ \(напредно\)-`,
  year_pattern: defaultYearPattern,
};

const mappingsOf = (payload: unknown): unknown =>
  z.object({ pattern_mappings: z.unknown() }).parse(payload).pattern_mappings;

describe('a new course', () => {
  test('is the only write the hook sees: an update, a rename included, keeps the mappings', () => {
    const events: string[] = [];
    registerCourseDefaultMapping((event) => {
      events.push(event);
    });

    expect(events).toEqual(['courses.items.create']);
  });

  test('without mappings gets exactly its default one as a nested create', () => {
    const created = withDefaultMapping({ name, status: 'active' });

    expect(created).toEqual({
      name,
      pattern_mappings: [defaultMapping],
      status: 'active',
    });
    expect(defaultPattern(name)).toBe(defaultMapping.pattern);
    expect(
      mappingsOf(withDefaultMapping({ name, pattern_mappings: null })),
    ).toEqual([defaultMapping]);
  });

  test('with mappings to create keeps them and gains its default, in either form', () => {
    const english = {
      pattern: String.raw`C\+\+ advanced-`,
      year_pattern: defaultYearPattern,
    };
    const yearly = { only_in_year: 3, pattern: String.raw`C\+\+ лаб` };

    expect(
      mappingsOf(withDefaultMapping({ name, pattern_mappings: [english, 12] })),
    ).toEqual([english, 12, defaultMapping]);
    expect(
      mappingsOf(
        withDefaultMapping({
          name,
          pattern_mappings: { create: [yearly], delete: [], update: [] },
        }),
      ),
    ).toEqual({ create: [yearly, defaultMapping], delete: [], update: [] });
    expect(
      mappingsOf(
        withDefaultMapping({ name, pattern_mappings: { update: [] } }),
      ),
    ).toEqual({ create: [defaultMapping], update: [] });
  });

  test('that already creates its default mapping gains no second one', () => {
    for (const own of [
      defaultMapping,
      { pattern: defaultMapping.pattern },
      { only_in_year: null, ...defaultMapping },
    ]) {
      expect(
        mappingsOf(withDefaultMapping({ name, pattern_mappings: [own] })),
      ).toEqual([own]);
      expect(
        mappingsOf(
          withDefaultMapping({ name, pattern_mappings: { create: [own] } }),
        ),
      ).toEqual({ create: [own] });
    }
    // The same pattern in one year, or an existing row, is another row.
    for (const other of [
      { only_in_year: 3, pattern: defaultMapping.pattern },
      { id: 9, ...defaultMapping },
    ]) {
      expect(
        mappingsOf(withDefaultMapping({ name, pattern_mappings: [other] })),
      ).toEqual([other, defaultMapping]);
    }
  });

  test('with an explicitly empty list loses the key and gains nothing', () => {
    expect(withDefaultMapping({ name, pattern_mappings: [] })).toEqual({
      name,
    });
  });

  test('without a name is left to the database', () => {
    for (const payload of [{ status: 'active' }, { name: 7 }, null, [name]]) {
      expect(withDefaultMapping(payload)).toBe(payload);
    }
  });
});

describe('the import', () => {
  const noLink = { matches: [], precedent: null, resolution: 'none' } as const;
  const candidate: CourseCandidate = {
    current: noLink,
    id: 1,
    legacy: { entry: noLink, equivalencies: noLink, source: 'none' },
    patterns: [],
    teaching: { links: [], source: null, status: 'active' },
  };

  test('posts every course with an empty list, so the hook adds nothing, and no other row', () => {
    const course = postedRecord('courses', { name, tags: null });

    expect(course).toEqual({ name, pattern_mappings: [], tags: null });
    expect(withDefaultMapping(course)).toEqual({ name, tags: null });
    expect(postedRecord('staff', { name })).toEqual({ name });
  });

  test("plans the course's standard mapping as the hook would create it", () => {
    const plan = planPatternMappings({
      academicYears: ['2025/2026'],
      candidates: [candidate],
      courses: [
        {
          available_2018: null,
          available_2023: null,
          credits_2018: null,
          credits_2023: null,
          export_assistants: null,
          id: 1,
          name,
          name_2018_override: null,
          name_2023: null,
          typed_professors: null,
        },
      ],
      users: [],
    });

    expect(plan.rows.map(({ record }) => record)).toEqual([
      {
        course: { collection: 'courses', key: '1' },
        only_in_year: null,
        ...defaultMapping,
      },
    ]);
    expect(mappingsOf(withDefaultMapping({ name }))).toEqual([defaultMapping]);
  });
});
