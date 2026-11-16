import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { SqlClient, SqlDatabase } from '../coordination/sql-port.js';

import { affected, json, openGuard, run } from '../coordination/sql-run.js';
import {
  lessonsOf,
  type ListedTimetable,
  listingSchema,
  mainTimetables,
  recentTimetables,
  semesterOf,
  slotsOf,
  type Timetable,
  timetableSchema,
} from './parse.js';
import {
  clearLessonsSql,
  clearSlotsSql,
  clearTeachingSql,
  fingerprintSql,
  fingerprintsSql,
  insertLessonsSql,
  insertSlotsSql,
  insertTeachingSql,
  matchLessonsSql,
  matchSlotsSql,
  teachingLockSql,
  unmatchedSql,
  upsertTimetablesSql,
} from './sql.js';

// The timetable import: reads the listing and the main timetables from
// timetables-api.finki-hub.com, stores every listed timetable and the
// lessons of each main one that changed, then rebuilds course_teaching,
// all in one transaction.

export const defaultTimetablesApi = 'https://timetables-api.finki-hub.com';

export const importOptionsSchema = z.object({
  // Fetch every main timetable again, not only the visible ones and those
  // never imported. The Flow passes it as a template: only true or 'true'
  // turns it on, whatever an absent one renders as.
  all: z
    .unknown()
    .optional()
    .transform((value) => value === true || value === 'true'),
});

export type Fetched = {
  readonly json: unknown;
  readonly text: string;
};

export type ImportSummary = {
  readonly changed: readonly string[];
  readonly empty: readonly string[];
  readonly fetched: number;
  readonly lessons: number;
  readonly main: number;
  readonly slots: number;
  readonly teaching: number;
  readonly timetables: number;
  readonly unmatched: {
    readonly rooms: number;
    readonly subjects: number;
    readonly teachers: number;
  };
};

export type TimetableSource = (path: string) => Promise<Fetched>;

const fingerprintRows = z.array(
  z.object({ edupage_id: z.string(), fingerprint: z.string().nullable() }),
);
const unmatchedRow = z.object({
  rooms: z.coerce.number().int(),
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

// Rebuilds course_teaching, the lessons' match columns and the slots'
// courses and rooms from the stored lessons and slots, the courses, the
// staff, the rooms and the three alias lists. The caller's
// transaction must not have opened another writer's guard. The lock makes
// an import and a rebuild after an edit run one after the other.
export const rebuildTeaching = async (
  client: SqlClient,
): Promise<{
  readonly teaching: number;
  readonly unmatched: ImportSummary['unmatched'];
}> => {
  await run(client, teachingLockSql);
  await openGuard(client, 'course_teaching');
  await run(client, clearTeachingSql);
  const teaching = await affected(client, insertTeachingSql);
  await run(client, matchLessonsSql);
  await run(client, matchSlotsSql);
  const unmatched = await run(client, unmatchedSql);
  return { teaching, unmatched: unmatchedRow.parse(unmatched.rows[0]) };
};

type Download = {
  readonly fingerprint: string;
  readonly timetable: ListedTimetable;
  readonly value: Timetable;
};

type Plan = {
  readonly all: boolean;
  readonly known: ReadonlyMap<string, null | string>;
  readonly listed: readonly ListedTimetable[];
};

type Round = {
  // Fetched and parsed, empty ones included.
  readonly downloads: readonly Download[];
  // Answered without a card: never a main timetable this run.
  readonly empty: ReadonlySet<string>;
  readonly main: ReadonlySet<string>;
};

// How many timetables are fetched at once.
const fetchConcurrency = 4;

const fetchOne = async (
  timetable: ListedTimetable,
  source: TimetableSource,
): Promise<Download> => {
  const response = await source(`/timetables/${timetable.id}`);
  const parsed = timetableSchema.safeParse(response.json);
  if (!parsed.success) {
    throw new TimetableImportError(
      `Timetable ${timetable.id}: unexpected response`,
      { code: 'TIMETABLE_INVALID' },
    );
  }
  return {
    fingerprint: sha256(response.text),
    timetable,
    value: parsed.data,
  };
};

// The timetables in groups of fetchConcurrency, one group after another.
const fetchAll = async (
  timetables: readonly ListedTimetable[],
  source: TimetableSource,
): Promise<Download[]> => {
  if (timetables.length === 0) {
    return [];
  }
  const group = await Promise.all(
    timetables
      .slice(0, fetchConcurrency)
      .map((timetable) => fetchOne(timetable, source)),
  );
  return [
    ...group,
    ...(await fetchAll(timetables.slice(fetchConcurrency), source)),
  ];
};

// Fetches the main timetables not fetched yet that need it: every one
// never imported or still visible on EduPage (with `all`, every one). A
// main timetable that answers empty stops being main, so the one before it
// in its semester is fetched in the next round when it needs to be.
const fetchRound = async (
  plan: Plan,
  round: Round,
  source: TimetableSource,
): Promise<Round> => {
  const { all, known, listed } = plan;
  const fetched = new Set(round.downloads.map(({ timetable }) => timetable.id));
  const wanted = listed.filter(
    ({ hidden, id }) =>
      round.main.has(id) &&
      !fetched.has(id) &&
      (all || (known.get(id) ?? null) === null || !hidden),
  );
  if (wanted.length === 0) {
    return round;
  }
  const downloads = [...round.downloads, ...(await fetchAll(wanted, source))];
  const empty = new Set(
    downloads
      .filter(({ value }) => value.cards.length === 0)
      .map(({ timetable }) => timetable.id),
  );
  const main = mainTimetables(listed.filter(({ id }) => !empty.has(id)));
  return fetchRound(plan, { downloads, empty, main }, source);
};

// The timetables whose lessons are stored: those that answered with cards
// and changed, or with `all` every one, so a parser change reaches them.
const toStore = (
  { all, known }: Plan,
  downloads: readonly Download[],
): Download[] =>
  downloads.filter(
    ({ fingerprint, timetable, value }) =>
      value.cards.length > 0 &&
      (all || fingerprint !== known.get(timetable.id)),
  );

const readListing = async (
  source: TimetableSource,
): Promise<readonly ListedTimetable[]> => {
  const response = await source('/timetables');
  const listing = listingSchema.safeParse(response.json);
  if (!listing.success || listing.data.length === 0) {
    throw new TimetableImportError(
      'Timetable listing: unexpected or empty response',
      { code: 'LISTING_INVALID' },
    );
  }
  return listing.data;
};

export const runTimetableImport = async (
  options: unknown,
  database: SqlDatabase,
  source: TimetableSource,
): Promise<ImportSummary> => {
  const { all } = importOptionsSchema.parse(options ?? {});
  const listed = await readListing(source);
  const stored = await run(database, fingerprintsSql);
  const known = new Map(
    fingerprintRows
      .parse(stored.rows)
      .map((row) => [row.edupage_id, row.fingerprint]),
  );
  const plan = { all, known, listed };
  const { downloads, empty, main } = await fetchRound(
    plan,
    { downloads: [], empty: new Set(), main: mainTimetables(listed) },
    source,
  );
  const stores = toStore(plan, downloads);
  const recent = recentTimetables(listed, main);
  const timetables = listed.map((timetable) => {
    const { academicYear, term } = semesterOf(timetable.dateFrom);
    return {
      academic_year: academicYear,
      date_from: timetable.dateFrom,
      edupage_id: timetable.id,
      hidden: timetable.hidden,
      main: main.has(timetable.id),
      recent: recent.has(timetable.id),
      term,
      title: timetable.title,
    };
  });
  const changed = stores.map(({ timetable }) => timetable.id);
  const lessonRows = stores.flatMap(({ timetable, value }) =>
    lessonsOf(value).map((lesson) => ({ ...lesson, edupage_id: timetable.id })),
  );
  const slotRows = stores.flatMap(({ timetable, value }) =>
    slotsOf(value).map((slot) => ({ ...slot, edupage_id: timetable.id })),
  );
  const fingerprints = stores.map(({ fingerprint, timetable }) => ({
    edupage_id: timetable.id,
    fingerprint,
  }));
  return database.transaction(async (client) => {
    await run(client, teachingLockSql);
    await openGuard(client, 'timetables');
    await run(client, upsertTimetablesSql, [json(timetables)]);
    await run(client, clearLessonsSql, [json(changed)]);
    const lessons = await affected(client, insertLessonsSql, [
      json(lessonRows),
    ]);
    await run(client, clearSlotsSql, [json(changed)]);
    const slots = await affected(client, insertSlotsSql, [json(slotRows)]);
    await run(client, fingerprintSql, [json(fingerprints)]);
    const rebuilt = await rebuildTeaching(client);
    return {
      changed,
      empty: [...empty],
      fetched: downloads.length,
      lessons,
      main: main.size,
      slots,
      teaching: rebuilt.teaching,
      timetables: listed.length,
      unmatched: rebuilt.unmatched,
    };
  });
};

// The source over the timetables API: GET <base><path>, JSON, within a
// minute; any failure answers TIMETABLES_API_FAILED.
export const httpSource =
  (base: string, fetcher: typeof fetch = fetch): TimetableSource =>
  async (path) => {
    const root = base.endsWith('/') ? base.slice(0, -1) : base;
    let response: Response;
    try {
      response = await fetcher(`${root}${path}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new TimetableImportError(
        `Timetables API ${path}: unreachable or too slow`,
        { cause: error, code: 'TIMETABLES_API_FAILED' },
      );
    }
    if (!response.ok) {
      throw new TimetableImportError(
        `Timetables API ${path}: HTTP ${String(response.status)}`,
        { code: 'TIMETABLES_API_FAILED' },
      );
    }
    const text = await response.text();
    try {
      return { json: JSON.parse(text) as unknown, text };
    } catch (error) {
      throw new TimetableImportError(`Timetables API ${path}: not JSON`, {
        cause: error,
        code: 'TIMETABLES_API_FAILED',
      });
    }
  };
