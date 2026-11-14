import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { defaultYearPattern } from '../directus/extensions/directus-extension-data-operations/src/enrollment-lines.js';
import {
  checkPatternMapping,
  patternMappingCreate,
  registerPatternGuard,
} from '../directus/extensions/directus-extension-data-operations/src/pattern-guard.js';

const directusError = z.object({
  code: z.literal('INVALID_PAYLOAD'),
  extensions: z.object({ field: z.enum(['pattern', 'year_pattern']) }),
  message: z.string(),
  name: z.literal('DirectusError'),
  status: z.literal(400),
});

// The refusal a write gets, as the Directus error handler reads it.
const refusalOf = (write: () => unknown) => {
  try {
    write();
  } catch (error) {
    return directusError.parse(error);
  }
  throw new Error('the write was not refused');
};

const handlers = () => {
  const registered = new Map<string, (payload: unknown) => unknown>();
  registerPatternGuard((event, handler) => {
    registered.set(event, handler);
  });
  return registered;
};

describe('the pattern guard', () => {
  test('checks every create and update of a pattern mapping through Directus', () => {
    expect(handlers().keys().toArray()).toEqual([
      'moodle_pattern_mappings.items.create',
      'moodle_pattern_mappings.items.update',
    ]);
  });

  test.each([
    [{ pattern: 'Курс-(' }, 'pattern: Unterminated group'],
    [{ pattern: String.raw`Веб\-програмирање` }, 'pattern: Invalid escape'],
    [
      { pattern: 'Курс-', year_pattern: String.raw`(?<start>\d{4}` },
      'year_pattern: Unterminated group',
    ],
    [
      { pattern: 'Курс-', year_pattern: String.raw`(\d{4})/(\d{4})` },
      'year_pattern: no group named start or end',
    ],
    [
      { pattern: 'Курс-', year_pattern: String.raw`(?<year>\d{4})` },
      'year_pattern: no group named start or end',
    ],
  ])('refuses %j on create and on update with HTTP 400', (payload, reason) => {
    for (const handler of handlers().values()) {
      const refusal = refusalOf(() => handler(payload));

      expect(refusal.message).toBe(`Invalid pattern mapping: ${reason}`);
      expect(refusal.extensions.field).toBe(
        reason.includes(':') ? reason.slice(0, reason.indexOf(':')) : reason,
      );
    }
  });

  test('never quotes the pattern it refuses', () => {
    const refusal = refusalOf(() => {
      checkPatternMapping({ pattern: 'SENTINEL_PATTERN(' });
    });

    expect(refusal.message).not.toContain('SENTINEL_PATTERN');
  });

  test('passes a valid mapping, and an update that writes neither pattern', () => {
    const update = handlers().get('moodle_pattern_mappings.items.update');
    const valid = {
      course: 4,
      pattern: String.raw`Курс-|Course \d{4}-`,
      year_pattern: String.raw`(?<end>\d{4})`,
    };

    expect(patternMappingCreate(valid)).toBe(valid);
    expect(update?.({ course: 5 })).toEqual({ course: 5 });
    expect(update?.({ only_in_year: 3, year_pattern: null })).toEqual({
      only_in_year: 3,
      year_pattern: null,
    });
  });

  test('creates a mapping with a year and no year pattern with year_pattern null, so the column default does not set both', () => {
    expect(
      patternMappingCreate({ course: 4, only_in_year: 7, pattern: 'Курс' }),
    ).toEqual({
      course: 4,
      only_in_year: 7,
      pattern: 'Курс',
      year_pattern: null,
    });
    expect(
      patternMappingCreate({
        course: 4,
        only_in_year: 7,
        pattern: 'Курс',
        year_pattern: defaultYearPattern,
      }),
    ).toEqual({
      course: 4,
      only_in_year: 7,
      pattern: 'Курс',
      year_pattern: defaultYearPattern,
    });

    for (const payload of [
      { course: 4, pattern: 'Курс-' },
      { course: 4, only_in_year: null, pattern: 'Курс-' },
    ]) {
      expect(patternMappingCreate(payload)).toEqual(payload);
    }
  });
});
