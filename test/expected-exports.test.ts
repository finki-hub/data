import { describe, expect, test } from 'vitest';

import {
  asData,
  casePath,
  committedFiles,
  committedText,
  expectedKeys,
  expectedRows,
  exportCases,
  oracleFiles,
  publicFileNames,
} from './expected-exports.js';

// Every committed public file once, with the first case that reads it.
const publicFiles = exportCases
  .flatMap((name) =>
    publicFileNames.map((file) => ({
      file,
      name,
      relative: casePath(name, file),
    })),
  )
  .filter(
    (entry, index, all) =>
      all.findIndex(({ relative }) => relative === entry.relative) === index,
  );

describe('the committed expected exports', () => {
  test('hold exactly the files the oracle reads, rooms, staff and students only for parity and synthetic', async () => {
    await expect(committedFiles()).resolves.toEqual(oracleFiles);
  });

  test('are each 2-space JSON with a trailing newline', async () => {
    const texts = await Promise.all(
      oracleFiles.map(async (relative) => ({
        relative,
        text: await committedText(relative),
      })),
    );

    expect(
      texts
        .filter(
          ({ text }) =>
            text !== `${JSON.stringify(JSON.parse(text), null, 2)}\n`,
        )
        .map(({ relative }) => relative),
    ).toEqual([]);
  });

  test.each(publicFileNames)(
    'list distinct keys in keys/%s.json',
    async (file) => {
      const keys = await expectedKeys(file);

      expect(new Set(keys).size).toBe(keys.length);
    },
  );

  test.each(publicFiles)(
    '$relative holds rows of non-empty text values, each key listed in keys/$file.json',
    async ({ file, name }) => {
      const rows = await expectedRows(name, file);
      const keys = new Set(await expectedKeys(file));

      expect(rows.length).toBeGreaterThan(0);
      expect(
        rows.flatMap((row) => Object.keys(row)).filter((key) => !keys.has(key)),
      ).toEqual([]);
    },
  );
});

describe('the data comparator', () => {
  const rooms = [
    { location: 'Building B', name: 'Hall', floor: '2' },
    { location: 'Building A', name: 'Hall' },
    { location: 'Building A', name: 'Hall', floor: '0' },
  ];

  test('ignores row order and key order', () => {
    expect(asData('rooms', rooms.toReversed())).toEqual(
      asData(
        'rooms',
        rooms.map((row) =>
          Object.fromEntries(Object.entries(row).toReversed()),
        ),
      ),
    );
  });

  test('pairs rows by match key, then by their whole content', () => {
    expect(asData('rooms', rooms)).toEqual([
      { location: 'Building A', name: 'Hall', floor: '0' },
      { location: 'Building A', name: 'Hall' },
      { location: 'Building B', name: 'Hall', floor: '2' },
    ]);
  });

  test('compares every value as text, each row key set and the row multiset', () => {
    const students = [{ index: 'S-1', name: 'One' }, { index: 'S-1' }];

    expect(asData('students', students)).not.toEqual(
      asData('students', [{ index: 'S-1', name: 'One ' }, { index: 'S-1' }]),
    );
    expect(asData('students', students)).not.toEqual(
      asData('students', [
        { index: 'S-1', name: 'One' },
        { index: 'S-1', name: '' },
      ]),
    );
    expect(asData('students', students)).not.toEqual(
      asData('students', [...students, { index: 'S-1' }]),
    );
    expect(asData('courses', [{ name: 'A', count: '0' }])).not.toEqual(
      asData('courses', [{ name: 'A', count: '00' }]),
    );
  });
});
