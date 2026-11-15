import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { SqlClient, SqlDatabase } from '../coordination/sql-port.js';

import { affected, json, openGuard, run } from '../coordination/sql-run.js';
import {
  lessonsOf,
  type ListedTimetable,
  listingSchema,
  mainTimetables,
  semesterOf,
  type Timetable,
  timetableSchema,
} from './parse.js';
import {
  clearLessonsSql,
  clearTeachingSql,
  fingerprintSql,
  fingerprintsSql,
  insertLessonsSql,
  insertTeachingSql,
  matchLessonsSql,
  unmatchedSql,
  upsertTimetableSql,
} from './sql.js';

// The timetable import: reads the listing and the main timetables from
// timetables-api.finki-hub.com, stores every listed timetable and the
// lessons of each main one that changed, then rebuilds course_teaching,
// all in one transaction.

export const defaultTimetablesApi = 'https://timetables-api.finki-hub.com';

export const importOptionsSchema = z.object({
  // Fetch every main timetable again, not only the visible ones and those
  // never imported.
  all: z
    .union([z.boolean(), z.literal('true'), z.literal('false'), z.null()])
    .optional()
    .transform((value) => value === true || value === 'true'),
});

export type Fetched = {
  readonly json: unknown;
  readonly text: string;
};

export type ImportSummary = {
  readonly changed: readonly string[];
  readonly fetched: number;
  readonly lessons: number;
  readonly main: number;
  readonly teaching: number;
  readonly timetables: number;
  readonly unmatched: { readonly subjects: number; readonly teachers: number };
};

export type TimetableSource = (path: string) => Promise<Fetched>;

const fingerprintRows = z.array(
  z.object({ edupage_id: z.string(), fingerprint: z.string().nullable() }),
);
const idRow = z.object({ id: z.coerce.number().int() });
const unmatchedRow = z.object({
  subjects: z.coerce.number().int(),
  teachers: z.coerce.number().int(),
});

// A refusal of the import, with a code the Flow answers.
export class TimetableImportError extends Error {
  public readonly code: string;
  public override readonly name = 'TimetableImportError';

  public constructor(
    message: string,
    options: ErrorOptions & { readonly code: string },
  ) {
    super(message, options);
    this.code = options.code;
  }
}

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

// Rebuilds course_teaching and the lessons' match columns from the stored
// lessons, the courses, the staff and the two alias lists. The caller's
// transaction must not have opened another writer's guard.
export const rebuildTeaching = async (
  client: SqlClient,
): Promise<{
  readonly teaching: number;
  readonly unmatched: ImportSummary['unmatched'];
}> => {
  await openGuard(client, 'course_teaching');
  await run(client, clearTeachingSql);
  const teaching = await affected(client, insertTeachingSql);
  await run(client, matchLessonsSql);
  const unmatched = await run(client, unmatchedSql);
  return { teaching, unmatched: unmatchedRow.parse(unmatched.rows[0]) };
};

type Download = {
  readonly fingerprint: string;
  readonly timetable: ListedTimetable;
  readonly value: Timetable;
};

type DownloadPlan = {
  readonly all: boolean;
  readonly known: ReadonlyMap<string, null | string>;
  readonly listed: readonly ListedTimetable[];
  readonly main: ReadonlySet<string>;
};

// The main timetables to store: every one never imported or still visible
// on EduPage (with `all`, every one), unless its fingerprint is unchanged.
const download = async (
  { all, known, listed, main }: DownloadPlan,
  source: TimetableSource,
): Promise<{ downloads: Download[]; fetched: number }> => {
  const downloads: Download[] = [];
  let fetched = 0;
  for (const timetable of listed) {
    const previous = known.get(timetable.id) ?? null;
    if (
      !main.has(timetable.id) ||
      (!all && previous !== null && timetable.hidden)
    ) {
      continue;
    }
    const response = await source(`/timetables/${timetable.id}`);
    fetched += 1;
    const fingerprint = sha256(response.text);
    if (fingerprint === previous) {
      continue;
    }
    const parsed = timetableSchema.safeParse(response.json);
    if (!parsed.success) {
      throw new TimetableImportError(
        `Timetable ${timetable.id}: unexpected response`,
        { code: 'TIMETABLE_INVALID' },
      );
    }
    // An empty timetable never replaces stored lessons.
    if (parsed.data.cards.length === 0) {
      continue;
    }
    downloads.push({ fingerprint, timetable, value: parsed.data });
  }
  return { downloads, fetched };
};

export const runTimetableImport = async (
  options: unknown,
  database: SqlDatabase,
  source: TimetableSource,
): Promise<ImportSummary> => {
  const { all } = importOptionsSchema.parse(options ?? {});
  const response = await source('/timetables');
  const listing = listingSchema.safeParse(response.json);
  if (!listing.success || listing.data.length === 0) {
    throw new TimetableImportError(
      'Timetable listing: unexpected or empty response',
      { code: 'LISTING_INVALID' },
    );
  }
  const listed = listing.data;
  const main = mainTimetables(listed);
  const stored = await run(database, fingerprintsSql);
  const known = new Map(
    fingerprintRows
      .parse(stored.rows)
      .map((row) => [row.edupage_id, row.fingerprint]),
  );
  const { downloads, fetched } = await download(
    { all, known, listed, main },
    source,
  );
  return database.transaction(async (client) => {
    await openGuard(client, 'timetables');
    const ids = new Map<string, number>();
    for (const timetable of listed) {
      const { academicYear, term } = semesterOf(timetable.dateFrom);
      const upserted = await run(client, upsertTimetableSql, [
        timetable.id,
        timetable.title,
        timetable.dateFrom,
        academicYear,
        term,
        main.has(timetable.id),
        timetable.hidden,
      ]);
      ids.set(timetable.id, idRow.parse(upserted.rows[0]).id);
    }
    let lessons = 0;
    for (const { fingerprint, timetable, value } of downloads) {
      const id = ids.get(timetable.id);
      if (id === undefined) {
        continue;
      }
      const rows = lessonsOf(value);
      await run(client, clearLessonsSql, [id]);
      lessons += await affected(client, insertLessonsSql, [id, json(rows)]);
      await run(client, fingerprintSql, [fingerprint, id]);
    }
    const rebuilt = await rebuildTeaching(client);
    return {
      changed: downloads.map(({ timetable }) => timetable.id),
      fetched,
      lessons,
      main: main.size,
      teaching: rebuilt.teaching,
      timetables: listed.length,
      unmatched: rebuilt.unmatched,
    };
  });
};

// The source over the timetables API: GET <base><path>, JSON, within a
// minute.
export const httpSource =
  (base: string, fetcher: typeof fetch = fetch): TimetableSource =>
  async (path) => {
    const root = base.endsWith('/') ? base.slice(0, -1) : base;
    const response = await fetcher(`${root}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new TimetableImportError(
        `Timetables API ${path}: HTTP ${String(response.status)}`,
        { code: 'TIMETABLES_API_FAILED' },
      );
    }
    const text = await response.text();
    return { json: JSON.parse(text) as unknown, text };
  };
