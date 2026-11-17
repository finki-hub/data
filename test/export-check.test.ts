import { describe, expect, test } from 'vitest';

import type { PreparedFile } from '../directus/extensions/directus-extension-data-operations/src/exports/file-check.js';

import { restReader, runExportCheck } from '../src/export-check.js';

const prepared = (filename: string, rows: readonly unknown[]): PreparedFile => {
  const body = JSON.stringify(rows);
  return { body, bytes: body.length, filename, rows: rows.length, sha256: '' };
};

const run = async (
  files: Parameters<typeof runExportCheck>[1],
  live: Readonly<Record<string, string>>,
) => {
  const lines: string[] = [];
  const builds = await runExportCheck(
    {
      liveFile: (filename) => Promise.resolve(live[filename] ?? null),
      request: () => Promise.resolve([]),
      stdout: (line) => {
        lines.push(line);
      },
    },
    files,
  );
  return { builds, lines };
};

describe('the export check', () => {
  test('reads through REST with the native query of the read', async () => {
    const paths: string[] = [];
    const reader = restReader((path) => {
      paths.push(path);
      return Promise.resolve([{ id: 1 }]);
    });

    await expect(
      reader({
        collection: 'courses',
        fields: ['id', 'program.code'],
        filter: { status: { _eq: 'active' } },
        sort: ['id'],
      }),
    ).resolves.toEqual([{ id: 1 }]);

    const url = new URL(paths[0] ?? '', 'https://directus.test');

    expect(url.pathname).toBe('/items/courses');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      deep: '{"program":{"_limit":-1}}',
      fields: 'id,program.code',
      filter: '{"status":{"_eq":"active"}}',
      limit: '-1',
      sort: 'id',
    });
  });

  test('refuses a read that answers no list', async () => {
    const reader = restReader(() => Promise.resolve(null));

    await expect(
      reader({ collection: 'rooms', fields: ['id'], sort: ['id'] }),
    ).rejects.toThrow('rooms: the read is not a list');
  });

  test('compares each built file with the live one', async () => {
    const { builds, lines } = await run(
      [
        {
          build: () =>
            Promise.resolve(prepared('a.json', [{ x: 1 }, { x: 2 }])),
          filename: 'a.json',
        },
        {
          build: () =>
            Promise.resolve(prepared('b.json', [{ x: 1 }, { x: 3 }])),
          filename: 'b.json',
        },
        {
          build: () => Promise.resolve(prepared('c.json', [])),
          filename: 'c.json',
        },
      ],
      { 'a.json': '[{"x":1},{"x":2}]', 'b.json': '[{"x":1},{"x":2},{"x":2}]' },
    );

    expect(builds).toBeTruthy();
    expect(lines).toEqual([
      'a.json: builds, 2 rows; live 2, identical',
      'b.json: builds, 2 rows; live 3, 1 new, 2 gone',
      'c.json: builds, 0 rows; not served now',
    ]);
  });

  test('reports a refused file and goes on with the rest', async () => {
    const { builds, lines } = await run(
      [
        {
          build: () => Promise.reject(new Error('Course 7: professor missing')),
          filename: 'courses.json',
        },
        {
          build: () => Promise.resolve(prepared('rooms.json', [])),
          filename: 'rooms.json',
        },
      ],
      { 'rooms.json': '[]' },
    );

    expect(builds).toBe(false);
    expect(lines).toEqual([
      'courses.json: refused: Course 7: professor missing',
      'rooms.json: builds, 0 rows; live 0, identical',
    ]);
  });
});
