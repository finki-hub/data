import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import {
  countText,
  errorText,
  listText,
  pluralText,
  printSummary,
} from '../src/text.js';

describe('root text forms', () => {
  test('count with the noun that agrees', () => {
    expect(countText(1, 'case', 'cases')).toBe('1 case');
    expect(countText(5, 'case', 'cases')).toBe('5 cases');
    expect(countText(0, 'case', 'cases')).toBe('0 cases');
    expect(pluralText(2, 'argument', 'arguments')).toBe('arguments');
  });

  test('list at most five items, then the rest as a count', () => {
    expect(listText(['2', '3'])).toBe('2, 3');
    expect(listText(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c, d, e');
    expect(listText(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe(
      'a, b, c, d, e (+2 more)',
    );
    expect(listText(['a', 'b', 'c'], 2)).toBe('a, b (+1 more)');
    expect(listText([])).toBe('');
  });

  test('render an error on one line', () => {
    expect(errorText(new Error('synthetic outage'))).toBe('synthetic outage');
    expect(errorText('plain text')).toBe('plain text');
    expect(errorText(new Error('first line\n  second line\r\nthird'))).toBe(
      'first line second line third',
    );
  });

  test('render a refused response by the path and message of each issue', () => {
    const counted = z
      .array(z.object({ count: z.number() }))
      .safeParse([{ count: '12' }]);
    const listed = z.array(z.string()).safeParse({});
    const many = z
      .array(z.number())
      .safeParse(['a', 'b', 'c', 'd', 'e', 'f', 'g']);

    expect(counted.success || errorText(counted.error)).toBe(
      'unexpected response: 0.count: Invalid input: expected number, received string',
    );
    expect(listed.success || errorText(listed.error)).toBe(
      'unexpected response: Invalid input: expected array, received object',
    );
    expect(many.success || errorText(many.error)).toBe(
      'unexpected response: 0: Invalid input: expected number, received string; 1: Invalid input: expected number, received string; 2: Invalid input: expected number, received string; 3: Invalid input: expected number, received string; 4: Invalid input: expected number, received string (+2 more)',
    );
  });

  test('print a summary as one indented JSON document in one call', () => {
    const written: string[] = [];

    printSummary(
      {
        stdout: (text) => {
          written.push(text);
        },
      },
      { blockers: {}, mode: 'dry-run' },
    );

    expect(written).toEqual(['{\n  "blockers": {},\n  "mode": "dry-run"\n}']);
  });
});
