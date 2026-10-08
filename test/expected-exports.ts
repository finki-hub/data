import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

// The data oracle of the public exports: the rows each public file holds
// for the synthetic datasets the tests publish, committed as 2-space JSON
// under test/fixtures/expected-exports/<case>/. A file is compared as data
// (asData): the same rows, each with the same keys and every value in its
// exact text. Bytes, digests, layout, key order and row order are not
// compared; the engine's own tests cover those. A change to the published
// data edits these values by hand and never regenerates them from the
// engine. enrollments.json holds the count of every "<course>/<academic
// year>" and council.json the student name of every council membership.

const directory = path.join(
  import.meta.dirname,
  'fixtures',
  'expected-exports',
);

export const publicFileNames = [
  'courses',
  'rooms',
  'staff',
  'students',
] as const;

export type PublicFileName = (typeof publicFileNames)[number];

export type PublicRow = Readonly<Record<string, string>>;

// The professors texts of the assignment-text-<n> cases, in case order:
// the parity dataset with the first assignment row's text replaced.
export const assignmentTexts = [
  'Prof. Zed Alpha, Prof. Abe Alpha',
  'Prof. Zed Alpha; Prof. Abe Alpha',
  'Prof. Zed Alpha;Prof. Abe Alpha',
  'Prof. Zed Alpha\nProf. Abe Alpha',
  'Prof. Zed Alpha,Prof. Abe Alpha',
  'Prof. Zed Alpha ,  Prof. Abe Alpha',
  ' Prof. Zed Alpha, Prof. Abe Alpha',
  'Prof. Zed Alpha ',
] as const;

// The cases that hold all four public files.
const fullCases = ['parity', 'synthetic'] as const;

// The cases whose rooms, staff and students equal parity's: each holds
// its courses.json alone and takes the other three from parity.
const coursesCases = [
  'renamed-current',
  'unmatched-legacy',
  ...assignmentTexts.map(
    (_, index) => `assignment-text-${String(index + 1)}` as const,
  ),
] as const;

export type ExportCase =
  (typeof coursesCases)[number] | (typeof fullCases)[number];

const holdsAll = new Set<ExportCase>(fullCases);

export const exportCases: readonly ExportCase[] = [
  ...fullCases,
  ...coursesCases,
];

// The cases that hold enrollments.json.
const enrollmentCases = [
  'empty-history-pattern',
  'legacy-rules',
  'legacy-rules-empty',
  'legacy-rules-split',
  'synthetic',
] as const;

type EnrollmentCase = (typeof enrollmentCases)[number];

// The keys that pair a published row with its expected row: a course and
// a staff member by name, a room by location and name (room names repeat)
// and a student by index (indexes repeat).
const matchKeys: Readonly<Record<PublicFileName, readonly string[]>> = {
  courses: ['name'],
  rooms: ['location', 'name'],
  staff: ['name'],
  students: ['index'],
};

// Code-unit order: total and independent of the locale.
const byText = (left: string, right: string): number =>
  Number(left > right) - Number(left < right);

// A row as canonical JSON: its entries in key order.
const canonical = (row: PublicRow): string =>
  JSON.stringify(
    Object.entries(row).toSorted(([left], [right]) => byText(left, right)),
  );

// A file's rows as data: ordered by match key, then by canonical JSON.
// toEqual then compares the row multiset, each row's key set and every
// value as text, and neither the row order nor the key order.
export const asData = (
  file: PublicFileName,
  rows: readonly PublicRow[],
): PublicRow[] =>
  rows
    .map((row) => ({
      canonical: canonical(row),
      match: JSON.stringify(matchKeys[file].map((key) => row[key] ?? null)),
      row,
    }))
    .toSorted(
      (left, right) =>
        byText(left.match, right.match) ||
        byText(left.canonical, right.canonical),
    )
    .map(({ row }) => row);

// The four public files as data.
export const filesData = (
  files: Readonly<Record<PublicFileName, readonly PublicRow[]>>,
): Record<PublicFileName, PublicRow[]> => ({
  courses: asData('courses', files.courses),
  rooms: asData('rooms', files.rooms),
  staff: asData('staff', files.staff),
  students: asData('students', files.students),
});

// A committed file's text, by its case/file path.
export const committedText = (relative: string): Promise<string> =>
  readFile(path.join(directory, relative), 'utf8');

const committedJson = async (relative: string): Promise<unknown> => {
  const parsed: unknown = JSON.parse(await committedText(relative));
  return parsed;
};

// Every committed file, as case/file paths in code-unit order.
export const committedFiles = async (): Promise<readonly string[]> => {
  const cases = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    cases
      .filter((entry) => entry.isDirectory())
      .map(async ({ name }) => {
        const files = await readdir(path.join(directory, name));
        return files.map((file) => `${name}/${file}`);
      }),
  );
  return nested.flat().toSorted(byText);
};

// Where a case's public file is committed: in its own directory, or in
// parity's for the rooms, staff and students of a courses-only case.
export const casePath = (name: ExportCase, file: PublicFileName): string => {
  const holder = file === 'courses' || holdsAll.has(name) ? name : 'parity';
  return `${holder}/${file}.json`;
};

// Every file the oracle reads, in code-unit order.
export const oracleFiles: readonly string[] = [
  ...new Set([
    ...exportCases.flatMap((name) =>
      publicFileNames.map((file) => casePath(name, file)),
    ),
    ...publicFileNames.map((file) => `keys/${file}.json`),
    ...enrollmentCases.map((name) => `${name}/enrollments.json`),
    'synthetic/council.json',
  ]),
].toSorted(byText);

const rowsSchema = z.array(z.record(z.string(), z.string().min(1)));

// The rows of a case's public file, in their committed order.
export const expectedRows = async (
  name: ExportCase,
  file: PublicFileName,
): Promise<readonly PublicRow[]> =>
  rowsSchema.parse(await committedJson(casePath(name, file)));

// The four public files of a case as data.
export const expectedData = async (
  name: ExportCase,
): Promise<Record<PublicFileName, PublicRow[]>> =>
  filesData({
    courses: await expectedRows(name, 'courses'),
    rooms: await expectedRows(name, 'rooms'),
    staff: await expectedRows(name, 'staff'),
    students: await expectedRows(name, 'students'),
  });

// The keys of each public file (the fifteen synthetic years and both
// published curriculum generations for courses), in their committed
// order, which the tests of declared key positions read.
export const expectedKeys = async (
  file: PublicFileName,
): Promise<readonly string[]> =>
  z.array(z.string().min(1)).parse(await committedJson(`keys/${file}.json`));

// The counts of a case keyed "<course>/<academic year>".
export const expectedEnrollments = async (
  name: EnrollmentCase,
): Promise<Readonly<Record<string, number>>> =>
  z
    .record(z.string(), z.number().int().nonnegative())
    .parse(await committedJson(`${name}/enrollments.json`));

// The student name of every council membership of the synthetic dataset:
// the first student row carrying the member's index.
export const expectedCouncil = async (): Promise<
  ReadonlyArray<{ readonly id: number; readonly name: null | string }>
> =>
  z
    .array(z.object({ id: z.number().int(), name: z.string().nullable() }))
    .parse(await committedJson('synthetic/council.json'));
