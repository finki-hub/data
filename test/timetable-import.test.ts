import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';

import type {
  SqlBinding,
  SqlClient,
  SqlDatabase,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/sql-port.js';

import { openGuardSql } from '../directus/extensions/directus-extension-data-operations/src/coordination/write-guards.js';
import {
  rebuildScheduler,
  registerTeachingRebuild,
  teachingInputs,
} from '../directus/extensions/directus-extension-data-operations/src/teaching-rebuild.js';
import {
  type Fetched,
  httpSource,
  runTimetableImport,
  TimetableImportError,
} from '../directus/extensions/directus-extension-data-operations/src/teaching/import.js';
import {
  lessonsOf,
  mainTimetables,
  recentTimetables,
  semesterOf,
  splitSubject,
} from '../directus/extensions/directus-extension-data-operations/src/teaching/parse.js';
import {
  clearLessonsSql,
  fingerprintSql,
  insertLessonsSql,
  insertTeachingSql,
  matchLessonsSql,
  teachingLockSql,
  upsertTimetablesSql,
} from '../directus/extensions/directus-extension-data-operations/src/teaching/sql.js';
import { teachingKeys } from '../src/data-model/teaching-collections.js';
import {
  timetableImportCron,
  timetableImportFlow,
  timetableScheduleFlow,
} from '../src/flows/timetable-import.js';
import { keyText } from './data-model-test-helpers.js';

const listingPath = '/timetables';
const databases = 'Бази на податоци';
const velinov = 'Горан Велинов';
const writeEvents = ['create', 'update', 'delete'];

const eventsOf = (collection: string): string[] =>
  writeEvents.map((event) => `${collection}.items.${event}`);

// The start dates of the fixture's two main timetables.
const winter2026 = '2026-10-10';
const summer2026 = '2026-02-23';

const listed = (id: string, dateFrom: string, hidden = true) => ({
  dateFrom,
  hidden,
  id,
  title: `raspored-${id}`,
  year: Number(dateFrom.slice(0, 4)),
});

const card = (subject: string, teachers: string[], durationPeriods = 2) => ({
  durationPeriods,
  subject: { id: '1', name: subject, short: subject },
  teachers: teachers.map((name, index) => ({
    id: String(index),
    name,
    short: name,
  })),
});

describe('timetable parsing', () => {
  test('splits a class type off a subject and keeps any other parentheses', () => {
    expect(splitSubject('Бази на податоци (п)')).toEqual({
      kind: 'п',
      subject: 'Бази на податоци',
    });
    expect(splitSubject('Автономна роботика(ав)')).toEqual({
      kind: 'ав',
      subject: 'Автономна роботика',
    });
    expect(splitSubject('Object-oriented programming (e)')).toEqual({
      kind: 'e',
      subject: 'Object-oriented programming',
    });
    expect(splitSubject('Компјутерски мрежи (и безбедност)')).toEqual({
      kind: null,
      subject: 'Компјутерски мрежи (и безбедност)',
    });
    expect(splitSubject('  Математика   2 ')).toEqual({
      kind: null,
      subject: 'Математика 2',
    });
  });

  test('places a timetable in the semester and academic year it starts in', () => {
    expect(semesterOf(winter2026)).toEqual({
      academicYear: '2026/2027',
      term: 'winter',
    });
    expect(semesterOf(summer2026)).toEqual({
      academicYear: '2025/2026',
      term: 'summer',
    });
    expect(semesterOf('2027-01-05')).toEqual({
      academicYear: '2026/2027',
      term: 'winter',
    });
  });

  test('takes the timetable that starts last in each semester as its main one', () => {
    const main = mainTimetables([
      listed('31', winter2026, false),
      listed('30', '2026-10-02'),
      listed('28', summer2026),
      listed('27', '2026-02-15'),
      listed('3', '2020-10-09'),
      listed('4', '2020-10-16'),
    ]);

    expect(main).toEqual(new Set(['4', '28', '31']));
  });

  test('publishes the six latest main timetables, three years of semesters', () => {
    const timetables = [
      listed('31', winter2026, false),
      listed('30', '2026-10-02'),
      listed('28', summer2026),
      listed('26', '2025-10-04'),
      listed('25', '2025-02-21'),
      listed('23', '2024-10-05'),
      listed('22', '2024-02-24'),
      listed('20', '2023-10-06'),
    ];

    expect(recentTimetables(timetables, mainTimetables(timetables))).toEqual(
      new Set(['22', '23', '25', '26', '28', '31']),
    );
  });

  test('sums the weekly periods of each subject, class type and teacher', () => {
    const lessons = lessonsOf({
      cards: [
        card(`${databases} (п)`, [velinov]),
        card(`${databases} (п)`, [velinov], 1),
        card(`${databases} (ав)`, [velinov, 'Јана Кузманова']),
        card(`${databases} (ав)`, []),
      ],
    });

    expect(lessons).toEqual([
      {
        kind: 'п',
        periods: 3,
        subject: databases,
        teacher: velinov,
      },
      {
        kind: 'ав',
        periods: 2,
        subject: databases,
        teacher: velinov,
      },
      {
        kind: 'ав',
        periods: 2,
        subject: databases,
        teacher: 'Јана Кузманова',
      },
    ]);
  });
});

type Statement = { readonly bindings: SqlBinding[]; readonly sql: string };

// The JSON a batched statement binds.
const jsonBinding = ({ bindings }: Statement): unknown[] =>
  z.array(z.unknown()).parse(JSON.parse(String(bindings[0])));

// A database that records every statement and answers the few reads the
// import makes.
const fakeDatabase = (fingerprints: Record<string, string> = {}) => {
  const statements: Statement[] = [];
  const transactions: Statement[][] = [];
  const client = (log: Statement[]): SqlClient => ({
    raw: (sql, bindings = []) => {
      log.push({ bindings, sql });
      if (sql.startsWith('SELECT "edupage_id"')) {
        return Promise.resolve({
          rows: Object.entries(fingerprints).map(
            ([edupage_id, fingerprint]) => ({ edupage_id, fingerprint }),
          ),
        });
      }
      if (sql === insertLessonsSql) {
        return Promise.resolve({
          rowCount: jsonBinding({ bindings, sql }).length,
          rows: [],
        });
      }
      return sql.startsWith('SELECT\n  count(DISTINCT')
        ? Promise.resolve({ rows: [{ subjects: 2, teachers: 1 }] })
        : Promise.resolve({ rowCount: 3, rows: [] });
    },
  });
  const database: SqlDatabase = {
    ...client(statements),
    transaction: async (work) => {
      const log: Statement[] = [];
      transactions.push(log);
      return work(client(log));
    },
  };
  return { database, statements, transactions };
};

const fetched = (value: unknown): Fetched => ({
  json: value,
  text: JSON.stringify(value),
});

const timetable = { cards: [card(`${databases} (п)`, [velinov])] };

// A listed timetable as the import stores it.
const timetableRow = (
  id: string,
  dateFrom: string,
  flags: { readonly hidden: boolean; readonly main: boolean },
) => ({
  academic_year: semesterOf(dateFrom).academicYear,
  date_from: dateFrom,
  term: semesterOf(dateFrom).term,
  edupage_id: id,
  title: `raspored-${id}`,
  ...flags,
  // Both main timetables of the fixture are among the six latest.
  recent: flags.main,
});

const source =
  (listing: unknown, timetables: Record<string, unknown> = {}) =>
  (path: string): Promise<Fetched> =>
    Promise.resolve(
      fetched(
        path === listingPath
          ? listing
          : (timetables[path.replace('/timetables/', '')] ?? timetable),
      ),
    );

describe('the timetable import', () => {
  const listing = [
    listed('31', winter2026, false),
    listed('30', '2026-10-02'),
    listed('28', summer2026),
  ];

  test('stores every listed timetable and the lessons of each main one, then rebuilds course teaching in one transaction', async () => {
    const { database, transactions } = fakeDatabase();
    const fetchedPaths: string[] = [];
    const summary = await runTimetableImport({}, database, (path) => {
      fetchedPaths.push(path);
      return source(listing)(path);
    });

    expect(fetchedPaths).toEqual([
      listingPath,
      '/timetables/31',
      '/timetables/28',
    ]);
    expect(summary).toEqual({
      changed: ['31', '28'],
      empty: [],
      fetched: 2,
      lessons: 2,
      main: 2,
      teaching: 3,
      timetables: 3,
      unmatched: { subjects: 2, teachers: 1 },
    });
    expect(transactions).toHaveLength(1);

    const [statements = []] = transactions;

    expect(statements.slice(0, 2).map(({ sql }) => sql)).toEqual([
      teachingLockSql,
      openGuardSql('timetables'),
    ]);
    expect(statements.map(({ sql }) => sql).slice(2, 6)).toEqual([
      upsertTimetablesSql,
      clearLessonsSql,
      insertLessonsSql,
      fingerprintSql,
    ]);
    expect(statements.slice(2, 6).map(jsonBinding)).toEqual([
      [
        timetableRow('31', winter2026, { hidden: false, main: true }),
        timetableRow('30', '2026-10-02', { hidden: true, main: false }),
        timetableRow('28', summer2026, { hidden: true, main: true }),
      ],
      ['31', '28'],
      ['31', '28'].map((edupage_id) => ({
        edupage_id,
        kind: 'п',
        periods: 2,
        subject: databases,
        teacher: velinov,
      })),
      ['31', '28'].map((edupage_id) => ({
        edupage_id,
        fingerprint: createHash('sha256')
          .update(JSON.stringify(timetable))
          .digest('hex'),
      })),
    ]);
    expect(statements.map(({ sql }) => sql)).toContain(insertTeachingSql);
    expect(statements.map(({ sql }) => sql).at(-2)).toBe(matchLessonsSql);
  });

  test('fetches only visible and new timetables unless asked for all, and skips an unchanged one', async () => {
    const known = { '28': 'stored', '31': '' };
    const unchanged = fetched(timetable);
    const { database } = fakeDatabase({
      ...known,
      '31': createHash('sha256').update(unchanged.text).digest('hex'),
    });

    const quiet = await runTimetableImport({}, database, source(listing));

    expect(quiet.fetched).toBe(1);
    expect(quiet.changed).toEqual([]);

    const all = await runTimetableImport(
      { all: true },
      database,
      source(listing),
    );

    // `all` stores every one again, so a parser change reaches it.
    expect(all.fetched).toBe(2);
    expect(all.changed).toEqual(['31', '28']);
  });

  test('never stores an empty timetable and hands its semester to the one before it', async () => {
    const { database, transactions } = fakeDatabase();
    const summary = await runTimetableImport(
      {},
      database,
      source(listing, { '28': { cards: [] }, '31': { cards: [] } }),
    );

    expect(summary.empty).toEqual(['31', '28']);
    expect(summary.changed).toEqual(['30']);
    expect(summary.main).toBe(1);

    const upsert = transactions[0]?.find(
      ({ sql }) => sql === upsertTimetablesSql,
    );

    expect(
      (upsert === undefined ? [] : jsonBinding(upsert)).filter(
        (row) => z.object({ main: z.literal(true) }).safeParse(row).success,
      ),
    ).toHaveLength(1);
  });

  test('refuses a response that is not JSON with its own code', async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('<html>', { status: 200 })),
    );

    await expect(
      httpSource('https://api.example', fetcher)(listingPath),
    ).rejects.toMatchObject({
      code: 'TIMETABLES_API_FAILED',
      message: 'Timetables API /timetables: not JSON',
    });
  });

  test('refuses an empty or malformed listing and a malformed timetable before writing', async () => {
    const empty = fakeDatabase();

    await expect(
      runTimetableImport({}, empty.database, source([])),
    ).rejects.toThrow(TimetableImportError);
    expect(empty.transactions).toEqual([]);

    const malformed = fakeDatabase();

    await expect(
      runTimetableImport(
        {},
        malformed.database,
        source(listing, { '31': { cards: 'none' } }),
      ),
    ).rejects.toThrow('Timetable 31: unexpected response');
    expect(malformed.transactions).toEqual([]);
  });

  test('reads the API with a timeout and refuses an HTTP failure', async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('[]', { status: 200 })),
    );

    await expect(
      httpSource('https://api.example/', fetcher)(listingPath),
    ).resolves.toEqual({ json: [], text: '[]' });
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.example/timetables',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );

    const failing = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('', { status: 503 })),
    );

    await expect(
      httpSource('https://api.example', failing)(listingPath),
    ).rejects.toThrow('Timetables API /timetables: HTTP 503');
  });
});

describe('the course teaching rebuild', () => {
  test('runs once for a burst of edits and once more for an edit during a run', async () => {
    const runs = [
      Promise.withResolvers<undefined>(),
      Promise.withResolvers<undefined>(),
    ];
    let started = 0;
    const rebuild = vi.fn<() => Promise<undefined>>(() => {
      started += 1;
      return runs[started - 1]?.promise ?? Promise.resolve(undefined);
    });
    const schedule = rebuildScheduler(rebuild, { error: vi.fn<() => void>() });

    const first = schedule();
    void schedule();
    void schedule();
    runs[0]?.resolve(undefined);
    await vi.waitFor(() => {
      expect(rebuild).toHaveBeenCalledTimes(2);
    });
    runs[1]?.resolve(undefined);
    await first;

    expect(rebuild).toHaveBeenCalledTimes(2);
  });

  test('logs a failed rebuild and keeps serving later edits', async () => {
    const error = vi.fn<(message: string) => void>();
    const rebuild = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue();
    const schedule = rebuildScheduler(rebuild, { error });

    await schedule();
    await schedule();

    expect(error).toHaveBeenCalledWith('Course teaching rebuild failed: boom');
    expect(rebuild).toHaveBeenCalledTimes(2);
  });

  test('rebuilds after every item write to a collection it matches against', () => {
    const events: string[] = [];
    registerTeachingRebuild(
      (event) => {
        events.push(event);
      },
      fakeDatabase().database,
      { error: vi.fn<() => void>() },
    );
    const expected = teachingInputs.flatMap(eventsOf);

    expect(events).toEqual(expected);
  });
});

describe('the timetable import Flows', () => {
  test('offer the import on the dashboard and run it daily', () => {
    expect(timetableImportFlow.trigger).toBe('manual');
    expect(timetableImportFlow.options['collections']).toEqual([
      'data_operations',
    ]);
    expect(timetableScheduleFlow.trigger).toBe('schedule');
    expect(timetableScheduleFlow.options).toEqual({
      cron: timetableImportCron,
    });
    expect(timetableImportCron).toBe('0 30 4 * * *');
  });
});

describe('the teaching data keys', () => {
  test('keep one lesson, teaching row, alias and accreditation teacher per key', () => {
    expect(teachingKeys.map(keyText)).toEqual([
      'unique timetable_lessons (timetable, subject, kind, teacher)',
      'unique course_teaching (course, staff, timetable, role)',
      'index course_teaching (timetable)',
      'unique course_aliases (name, course)',
      'unique course_accreditation_staff (course, staff, generation)',
    ]);
  });
});
