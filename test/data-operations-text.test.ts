import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import {
  adminOnlyText,
  boundedText,
  countText,
  factsText,
  invalidOptionsText,
  issueLength,
  issuesText,
  listText,
} from '../directus/extensions/directus-extension-data-operations/src/text.js';

describe('data-operations text forms', () => {
  test('refuse a non-administrator in one form, without a trailing period', () => {
    expect(adminOnlyText('run data operations')).toBe(
      'Only administrators may run data operations',
    );
  });

  test('count and list as the root package does', () => {
    expect(countText(1, 'entry', 'entries')).toBe('1 entry');
    expect(countText(3, 'entry', 'entries')).toBe('3 entries');
    expect(listText(['1', '2', '3', '4', '5', '6'])).toBe(
      '1, 2, 3, 4, 5 (+1 more)',
    );
  });

  test('name each validation issue by its path, at most five, each bounded', () => {
    const long = 'x'.repeat(400);
    const cut = 'rows.3.entries: '.concat(long).slice(0, issueLength);

    expect(
      issuesText([
        { message: 'Invalid UUID', path: ['token'] },
        { message: long, path: ['rows', 3, 'entries'] },
      ]),
    ).toBe(`token: Invalid UUID; ${cut}`);
    expect(cut).toHaveLength(240);
    expect(
      issuesText(
        Array.from({ length: 8 }, (_, index) => ({
          message: 'Required',
          path: ['rows', index],
        })),
      ),
    ).toBe(
      'rows.0: Required; rows.1: Required; rows.2: Required; rows.3: Required; rows.4: Required (+3 more)',
    );
  });

  test('keep the library message and name a root issue by its message alone', () => {
    const parsed = z
      .object({ action: z.enum(['claim', 'mark']) })
      .safeParse(null);

    expect(parsed.success || issuesText(parsed.error.issues)).toBe(
      'Invalid input: expected object, received null',
    );
    expect(
      issuesText([{ message: 'Moodle user 42: empty entry', path: [] }]),
    ).toBe('Moodle user 42: empty entry');
  });

  test('count the rest of a list whose first items alone were kept', () => {
    expect(boundedText(['3', '7'], { total: 2 })).toBe('3, 7');
    expect(boundedText(['1', '2', '3', '4', '5', '6'], { total: 23 })).toBe(
      '1, 2, 3, 4, 5 (+18 more)',
    );
    expect(
      boundedText(['row 2 has 3 cells, not 38', 'row 4 is required'], {
        separator: '; ',
        total: 3,
      }),
    ).toBe('row 2 has 3 cells, not 38; row 4 is required (+1 more)');
  });

  test('refuse operation options by their issues', () => {
    const parsed = z
      .discriminatedUnion('action', [
        z.object({ action: z.literal('claim') }),
        z.object({ action: z.literal('mark'), revision: z.number() }),
      ])
      .safeParse({ action: 'mark', revision: 'x' });

    expect(parsed.success || invalidOptionsText(parsed.error.issues)).toBe(
      'Invalid options: revision: Invalid input: expected number, received string',
    );
  });

  test('join the facts of a dashboard line', () => {
    expect(
      factsText([
        ['Users', 1_020],
        ['Indexed', 980],
        ['Domain', 'history index'],
      ]),
    ).toBe('Users: 1020 · Indexed: 980 · Domain: history index');
    expect(factsText([])).toBe('');
  });
});
