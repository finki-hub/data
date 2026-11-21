import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { SourceRead } from '../directus/extensions/directus-extension-data-operations/src/exports/types.js';

import {
  antoQuotes,
  buildPlainFile,
  degreeProgramCourses,
  degreePrograms,
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

// A curriculum entry as the read answers it; one without a semester is a
// named-list elective.
const entry = ({
  code,
  cycle,
  name,
  program,
  semester,
}: {
  readonly code: null | string;
  readonly cycle: null | string;
  readonly name: string;
  readonly program: string;
  readonly semester: null | number;
}) => ({
  code,
  course: { degree_cycle: cycle, name },
  credits: 6,
  group: semester === null ? 'named' : null,
  group_name: semester === null ? 'Изборни' : null,
  id: 1,
  kind: semester === null ? 'elective' : 'mandatory',
  program: { code: program },
  semester,
});

describe('the plain legacy files', () => {
  test('serves every public file of the old bucket under its name', () => {
    expect(legacyFiles.map(({ filename }) => filename)).toEqual([
      'courses.json',
      'rooms.json',
      'staff.json',
      'anto.json',
      'sessions.json',
      'degree_programs.json',
      'degree_program_courses.json',
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

  test('publishes the degree programs with their typed values', async () => {
    const file = await buildPlainFile(
      degreePrograms,
      readerOf([
        {
          code: 'DS23_1',
          cycle: 'second',
          ects: 60,
          title: null,
          title_en: 'Master of Science in Data Science',
        },
      ]),
    );

    expect(file.body).toBe(
      '[{"code":"DS23_1","cycle":"second","ects":60,"title":null,"title_en":"Master of Science in Data Science"}]',
    );
  });

  test('publishes each curriculum entry keyed by course name and cycle, by program and semester', async () => {
    const file = await buildPlainFile(
      degreeProgramCourses,
      readerOf([
        entry({
          code: 'B',
          cycle: 'second',
          name: 'Втор',
          program: 'SI23_2',
          semester: 1,
        }),
        entry({
          code: null,
          cycle: 'second',
          name: 'Изборен',
          program: 'BKK23_2',
          semester: null,
        }),
        entry({
          code: 'A',
          cycle: 'first',
          name: 'Работа со надарени ученици',
          program: 'BKK23_2',
          semester: 3,
        }),
        entry({
          code: 'C',
          cycle: 'second',
          name: 'Data Science',
          program: 'BKK23_2',
          semester: 1,
        }),
      ]),
    );
    const rows = z
      .array(z.looseObject({ course: z.string() }))
      .parse(JSON.parse(file.body));

    expect(rows.map(({ course }) => course)).toEqual([
      'Data Science',
      'Работа со надарени ученици',
      'Изборен',
      'Втор',
    ]);
    expect(rows[1]).toEqual({
      code: 'A',
      course: 'Работа со надарени ученици',
      credits: 6,
      cycle: 'first',
      group: null,
      group_name: null,
      kind: 'mandatory',
      program: 'BKK23_2',
      semester: 3,
    });
  });

  test('refuses a curriculum entry without a course', () => {
    expect(() =>
      degreeProgramCourses.payload([
        { course: null, id: 1, kind: 'elective', program: { code: 'X' } },
      ]),
    ).toThrow(
      'degree_program_courses.json: an entry has no program, course or kind',
    );
  });
});
