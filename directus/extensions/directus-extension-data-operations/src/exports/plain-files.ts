import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { PreparedFile } from './file-check.js';

import { rowsOf, type SourceReader } from './engine.js';
import { exportError } from './errors.js';
import { defaultMaxBytes, type Row, type SourceRead } from './types.js';

// The legacy files that are not a list of rows of text values: anto.json,
// the list of the Anto quotes, and sessions.json, an object from each exam
// session's name to the file name of its schedule, both read in id order,
// so a new row comes last, as it did in the old bucket; and
// degree_programs.json and degree_program_courses.json, the programs and
// their curricula, which the old bucket never had.

export type PlainFile = {
  readonly filename: string;
  // The published payload of the read rows; it throws an export error
  // when they cannot be published.
  readonly payload: (rows: readonly Row[]) => unknown;
  readonly read: SourceRead;
};

const quoteRows = z.array(z.object({ quote: z.string().trim().min(1) }));

const sessionRows = z.array(
  z.object({
    file: z.object({
      filename_download: z.string().trim().min(1),
      id: z.string().min(1),
    }),
    id: z.number(),
    name: z.string().trim().min(1),
  }),
);

export type SessionFile = { readonly id: string; readonly name: string };

const refuse = (filename: string, fault: string): never => {
  throw exportError('INVALID_PAYLOAD', `${filename}: ${fault}`);
};

export const antoQuotes: PlainFile = {
  filename: 'anto.json',
  payload: (rows) => {
    const parsed = quoteRows.safeParse(rows);
    return parsed.success
      ? parsed.data.map(({ quote }) => quote)
      : refuse('anto.json', 'a quote is empty');
  },
  read: { collection: 'anto_quotes', fields: ['id', 'quote'], sort: ['id'] },
};

const parseSessions = (rows: readonly Row[]) => {
  const parsed = sessionRows.safeParse(rows);
  return parsed.success
    ? parsed.data
    : refuse('sessions.json', 'a session has no name or file');
};

// The schedule file of every session by its published file name. Sessions
// may share one schedule (one file linked twice, as June and September
// 2022/2023 do); two different files under one name would make the name
// ambiguous, so they refuse the file.
export const sessionFiles = (
  rows: readonly Row[],
): ReadonlyMap<string, SessionFile> => {
  const files = new Map<string, SessionFile>();
  for (const { file, name } of parseSessions(rows)) {
    const filename = file.filename_download;
    const known = files.get(filename);
    if (known !== undefined && known.id !== file.id) {
      refuse('sessions.json', `two files are named ${filename}`);
    }
    files.set(filename, known ?? { id: file.id, name });
  }
  return files;
};

export const examSessions: PlainFile = {
  filename: 'sessions.json',
  payload: (rows) => {
    // Checks the file names are unambiguous first.
    sessionFiles(rows);
    return Object.fromEntries(
      parseSessions(rows).map(({ file, name }) => [
        name,
        file.filename_download,
      ]),
    );
  },
  read: {
    collection: 'exam_sessions',
    fields: ['id', 'name', 'file.id', 'file.filename_download'],
    sort: ['id'],
  },
};

const programRows = z.array(
  z.object({
    code: z.string().trim().min(1),
    cycle: z.string().nullable(),
    ects: z.number().nullable(),
    title: z.string().nullable(),
    title_en: z.string().nullable(),
  }),
);

// degree_programs.json: every degree program with its titles, cycle and
// ECTS, in code order; a title or the ECTS the program pages lack is null.
export const degreePrograms: PlainFile = {
  filename: 'degree_programs.json',
  payload: (rows) => {
    const parsed = programRows.safeParse(rows);
    return parsed.success
      ? parsed.data.map(({ code, cycle, ects, title, title_en }) => ({
          code,
          cycle,
          ects,
          title,
          title_en,
        }))
      : refuse('degree_programs.json', 'a program has no code');
  },
  read: {
    collection: 'degree_programs',
    fields: ['code', 'title', 'title_en', 'cycle', 'ects'],
    sort: ['code'],
  },
};

const programCourseRows = z.array(
  z.object({
    code: z.string().nullable(),
    course: z.object({
      degree_cycle: z.string().nullable(),
      name: z.string().trim().min(1),
    }),
    credits: z.number().nullable(),
    group: z.string().nullable(),
    group_name: z.string().nullable(),
    kind: z.string().min(1),
    program: z.object({ code: z.string().trim().min(1) }),
    semester: z.number().nullable(),
  }),
);

type ProgramCourse = z.infer<typeof programCourseRows>[number];

const textOrder = new Intl.Collator('mk');

// None sorts last.
const lastIfNone = (value: null | string): string => value ?? '￿';

// By program, then semester (none last), then catalog code (none last),
// then course name.
const programCourseOrder = (left: ProgramCourse, right: ProgramCourse) =>
  textOrder.compare(left.program.code, right.program.code) ||
  (left.semester ?? Infinity) - (right.semester ?? Infinity) ||
  textOrder.compare(lastIfNone(left.code), lastIfNone(right.code)) ||
  textOrder.compare(left.course.name, right.course.name);

// degree_program_courses.json: one row per course of a program's
// curriculum. `course` and `cycle` are the course's name and cycle in
// courses.json, together its key there (one name is in both cycles); the
// rest is the curriculum entry, null where the program page gives none.
export const degreeProgramCourses: PlainFile = {
  filename: 'degree_program_courses.json',
  payload: (rows) => {
    const parsed = programCourseRows.safeParse(rows);
    return parsed.success
      ? parsed.data.toSorted(programCourseOrder).map((row) => ({
          code: row.code,
          course: row.course.name,
          credits: row.credits,
          cycle: row.course.degree_cycle,
          group: row.group,
          group_name: row.group_name,
          kind: row.kind,
          program: row.program.code,
          semester: row.semester,
        }))
      : refuse(
          'degree_program_courses.json',
          'an entry has no program, course or kind',
        );
  },
  read: {
    collection: 'degree_program_courses',
    fields: [
      'id',
      'program.code',
      'course.name',
      'course.degree_cycle',
      'kind',
      'semester',
      'group',
      'group_name',
      'credits',
      'code',
    ],
    sort: ['id'],
  },
};

export const plainFiles: readonly PlainFile[] = [
  antoQuotes,
  examSessions,
  degreePrograms,
  degreeProgramCourses,
];

// One plain file from the live data as the published compact JSON.
export const buildPlainFile = async (
  file: PlainFile,
  reader: SourceReader,
): Promise<PreparedFile> => {
  const rows = rowsOf(`${file.filename} read rows`, await reader(file.read));
  const body = JSON.stringify(file.payload(rows));
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > defaultMaxBytes) {
    refuse(
      file.filename,
      `${String(bytes)} bytes, max ${String(defaultMaxBytes)}`,
    );
  }
  return {
    body,
    bytes,
    filename: file.filename,
    rows: rows.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
};
