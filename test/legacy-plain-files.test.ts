import { describe, expect, test } from 'vitest';

import type { SourceRead } from '../directus/extensions/directus-extension-data-operations/src/exports/types.js';

import {
  antoQuotes,
  buildPlainFile,
  examSessions,
  sessionFiles,
} from '../directus/extensions/directus-extension-data-operations/src/exports/plain-files.js';
import { legacyFiles } from '../directus/extensions/directus-extension-data-operations/src/legacy-endpoint.js';

const sha256Pattern = /^[\da-f]{64}$/u;

const session = (id: number, name: string, filename: string) => ({
  file: { filename_download: filename, id: `file-${String(id)}` },
  id,
  name,
});

const readerOf =
  (rows: readonly unknown[]) =>
  (read: SourceRead): Promise<readonly unknown[]> => {
    expect(read.fields).not.toContain('*');

    return Promise.resolve(rows);
  };

describe('the plain legacy files', () => {
  test('serves every public file of the old bucket under its name', () => {
    expect(legacyFiles.map(({ filename }) => filename)).toEqual([
      'courses.json',
      'rooms.json',
      'staff.json',
      'bachelor_theses.json',
      'master_theses.json',
      'anto.json',
      'sessions.json',
    ]);
  });

  test('publishes the Anto quotes as a list of texts in id order', async () => {
    const file = await buildPlainFile(
      antoQuotes,
      readerOf([
        { id: 1, quote: 'Прва' },
        { id: 2, quote: 'Втора' },
      ]),
    );

    expect(JSON.parse(file.body)).toEqual(['Прва', 'Втора']);
    expect(file.rows).toBe(2);
    expect(file.sha256).toMatch(sha256Pattern);
  });

  test('refuses an empty quote', () => {
    expect(() => antoQuotes.payload([{ id: 1, quote: ' ' }])).toThrow(
      'anto.json: a quote is empty',
    );
  });

  test('publishes each session name with its file name, in id order', async () => {
    const file = await buildPlainFile(
      examSessions,
      readerOf([
        session(1, '2025/2026 Септември', 'sep_2025_2026.xlsx'),
        session(2, '2025/2026 Јуни', 'jun_2025_2026.xlsx'),
      ]),
    );

    expect(file.body).toBe(
      '{"2025/2026 Септември":"sep_2025_2026.xlsx","2025/2026 Јуни":"jun_2025_2026.xlsx"}',
    );
  });

  test('finds the schedule file of a published file name', () => {
    const files = sessionFiles([
      session(1, '2025/2026 Јуни', 'jun_2025_2026.xlsx'),
    ]);

    expect(files.get('jun_2025_2026.xlsx')).toEqual({
      id: 'file-1',
      name: '2025/2026 Јуни',
    });
    expect(files.get('other.pdf')).toBeUndefined();
  });

  test('lets two sessions share one schedule file', async () => {
    const sharedName = 'jun_sep.xlsx';
    const shared = {
      file: { filename_download: sharedName, id: 'file-1' },
      id: 2,
      name: 'Септември',
    };
    const rows = [session(1, 'Јуни', sharedName), shared];
    const file = await buildPlainFile(examSessions, readerOf(rows));

    expect(JSON.parse(file.body)).toEqual({
      Јуни: sharedName,
      Септември: sharedName,
    });
    expect(sessionFiles(rows).get(sharedName)?.id).toBe('file-1');
  });

  test('refuses two different files under one file name', () => {
    expect(() =>
      sessionFiles([session(1, 'A', 'same.pdf'), session(2, 'B', 'same.pdf')]),
    ).toThrow('two files are named same.pdf');
  });

  test('refuses a session without a file', () => {
    expect(() => sessionFiles([{ file: null, id: 1, name: 'A' }])).toThrow(
      'a session has no name or file',
    );
  });
});
