import { describe, expect, test, vi } from 'vitest';

import type * as Generations from '../src/import/generations.js';

import { workbookGenerations } from '../src/import/generations.js';
import { readWithout } from './generation-columns-helpers.js';

// The workbook generations with the curriculum flags of 2018 and 2013
// swapped: the reader lets a column be missing by the flag, never by the
// code.
vi.mock('../src/import/generations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Generations>();
  return {
    ...actual,
    workbookGenerations: actual.workbookGenerations.map((generation) =>
      generation.code === '2023'
        ? generation
        : { ...generation, has_curriculum: !generation.has_curriculum },
    ),
  };
});

describe('the Еквиваленции sheet under other curriculum flags', () => {
  test('reads a missing column of a generation flagged label-only as empty, and refuses one of a generation flagged with a curriculum, 2013 included', () => {
    expect(
      workbookGenerations.map(({ code, has_curriculum }) => [
        code,
        has_curriculum,
      ]),
    ).toEqual([
      ['2013', true],
      ['2018', false],
      ['2023', true],
    ]);
    expect(
      workbookGenerations.map((generation) => [
        generation.code,
        readWithout(generation),
      ]),
    ).toEqual([
      ['2013', 'Еквиваленции row 1: missing column "Предмет (2013)"'],
      ['2018', [null]],
      ['2023', 'Еквиваленции row 1: missing column "Предмет (2023)"'],
    ]);
  });
});
