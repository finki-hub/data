import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

// The byte-identity oracle of the public exports: what the checkpoint
// serializer and derivation answered for every synthetic dataset the tests
// compare against, committed under test/fixtures/expected-exports/<case>/
// with a SHA256SUMS file before that code was removed. A public file is
// the exact compact JSON the export engine publishes; enrollments.json
// holds the count of every "<course>/<academic year>" and council.json the
// student name of every council membership. Every read is checked against
// SHA256SUMS first.

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

export type AssignmentTextCase = `assignment-text-${string}`;

// The cases that hold the four public files.
export type ExportCase =
  | 'lifecycle'
  | 'parity'
  | 'renamed-current'
  | 'synthetic'
  | 'unmatched-legacy'
  | AssignmentTextCase;

// The cases that hold enrollments.json.
export type EnrollmentCase =
  | 'empty-history-pattern'
  | 'legacy-rules'
  | 'legacy-rules-empty'
  | 'legacy-rules-split'
  | 'synthetic';

export const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

const sumLine = /^(?<digest>[0-9a-f]{64}) {2}(?<file>\S+)$/u;

const collator = new Intl.Collator('en');

const sumsText = await readFile(path.join(directory, 'SHA256SUMS'), 'utf8');

// Every committed file and its sha256, as SHA256SUMS lists them.
export const expectedSums: ReadonlyMap<string, string> = new Map(
  sumsText
    .trimEnd()
    .split('\n')
    .map((line) => {
      const { digest, file } = sumLine.exec(line)?.groups ?? {};
      if (digest === undefined || file === undefined) {
        throw new Error(`SHA256SUMS holds a malformed line: ${line}`);
      }
      return [file, digest] as const;
    }),
);

// Every file of the directory but SHA256SUMS, as case/file paths in
// English collation order.
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
  return nested.flat().toSorted((left, right) => collator.compare(left, right));
};

// A committed file's text, refused unless it carries the sha256 that
// SHA256SUMS lists for it.
export const committed = async (relative: string): Promise<string> => {
  const body = await readFile(path.join(directory, relative), 'utf8');
  if (expectedSums.get(relative) !== sha256(body)) {
    throw new Error(`${relative} does not match SHA256SUMS`);
  }
  return body;
};

export type ExpectedFile = {
  readonly body: string;
  readonly sha256: string;
};

const expectedFile = async (
  name: ExportCase,
  file: PublicFileName,
): Promise<ExpectedFile> => {
  const body = await committed(`${name}/${file}.json`);
  return { body, sha256: sha256(body) };
};

// The four public files of a case, keyed by their name without `.json`.
export const expectedFiles = async (
  name: ExportCase,
): Promise<Readonly<Record<PublicFileName, ExpectedFile>>> => ({
  courses: await expectedFile(name, 'courses'),
  rooms: await expectedFile(name, 'rooms'),
  staff: await expectedFile(name, 'staff'),
  students: await expectedFile(name, 'students'),
});

const rowsSchema = z.array(z.record(z.string(), z.string()));

// The rows of a case's public file.
export const expectedRows = async (
  name: ExportCase,
  file: PublicFileName,
): Promise<ReadonlyArray<Readonly<Record<string, string>>>> =>
  rowsSchema.parse(JSON.parse(await committed(`${name}/${file}.json`)));

// The keys of each public file, in output order (the fifteen checkpoint
// years and both published curriculum generations for courses).
export const expectedKeys = async (
  file: PublicFileName,
): Promise<readonly string[]> =>
  z.array(z.string()).parse(JSON.parse(await committed(`keys/${file}.json`)));

// The counts of a case keyed "<course>/<academic year>".
export const expectedEnrollments = async (
  name: EnrollmentCase,
): Promise<Readonly<Record<string, number>>> =>
  z
    .record(z.string(), z.number().int().nonnegative())
    .parse(JSON.parse(await committed(`${name}/enrollments.json`)));

// The student name of every council membership of the synthetic dataset:
// the first student row carrying the member's index.
export const expectedCouncil = async (): Promise<
  ReadonlyArray<{ readonly id: number; readonly name: null | string }>
> =>
  z
    .array(z.object({ id: z.number().int(), name: z.string().nullable() }))
    .parse(JSON.parse(await committed('synthetic/council.json')));
