import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';

import type {
  SqlBinding,
  SqlClient,
  SqlDatabase,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/sql-port.js';

import { openGuardSql } from '../directus/extensions/directus-extension-data-operations/src/coordination/write-guards.js';
import { staffResolvedSql } from '../directus/extensions/directus-extension-data-operations/src/teaching/sql.js';
import {
  httpThesisSource,
  runThesisImport,
  ThesisImportError,
} from '../directus/extensions/directus-extension-data-operations/src/theses/import.js';
import {
  isoDate,
  splitStudent,
  tidy,
} from '../directus/extensions/directus-extension-data-operations/src/theses/parse.js';
import {
  clearCommitteeSql,
  clearThesesSql,
  insertCommitteeSql,
  insertThesesSql,
  storedCountSql,
  thesisLockSql,
  unmatchedNamesSql,
} from '../directus/extensions/directus-extension-data-operations/src/theses/sql.js';
import {
  bachelorTable,
  masterTable,
} from '../directus/extensions/directus-extension-data-operations/src/theses/vocabulary.js';
import {
  registerThesisRebuild,
  thesisInputs,
} from '../directus/extensions/directus-extension-data-operations/src/thesis-rebuild.js';
import { thesisKeys } from '../src/data-model/thesis-collections.js';
import {
  thesisImportCron,
  thesisImportFlow,
  thesisScheduleFlow,
} from '../src/flows/thesis-import.js';
import { keyText } from './data-model-test-helpers.js';

const eventsOf = (collection: string): string[] =>
  ['create', 'update', 'delete'].map((event) => `${collection}.items.${event}`);

type Statement = { readonly bindings: SqlBinding[]; readonly sql: string };

const apis = {
  bachelors: 'https://bachelors.test/',
  masters: 'https://masters.test',
};
const bachelorsUrl = 'https://bachelors.test/diplomas';
const mastersUrl = 'https://masters.test/masters';

const bachelor = {
  dateOfSubmission: '2.11.2026',
  description: 'Апстракт',
  fileId: 9_850,
  member1: 'Георгина Мирчева',
  member2: 'Магдалена  Костоска',
  mentor: 'Игор Мишковски',
  status: 'Одбрана',
  student: '216022  - Бојана  Јанческа',
  title: ' Наслов ',
};

const master = {
  dateOfPresentation: '',
  description: 'Abstract',
  fileId: '1461',
  member: 'Игор Мишковски',
  mentor: 'Ристе Стојанов',
  president: 'Костадин Мишев',
  status: '24. Магистерската е завршена.',
  student: '1234 - Ана Петрова',
  title: 'Title',
};

// A database that records every statement, holding `stored` theses of
// each kind.
const fakeDatabase = (stored = 0) => {
  const transactions: Statement[][] = [];
  const client = (log: Statement[]): SqlClient => ({
    raw: (sql, bindings = []) => {
      log.push({ bindings, sql });
      if (sql.startsWith('SELECT count(*)')) {
        return Promise.resolve({ rows: [{ count: stored }] });
      }
      if (sql === unmatchedNamesSql) {
        return Promise.resolve({
          rows: [{ name: 'Тони Јаневски', theses: '9' }],
        });
      }
      return Promise.resolve({ rowCount: 5, rows: [] });
    },
  });
  const database: SqlDatabase = {
    ...client([]),
    transaction: async (work) => {
      const log: Statement[] = [];
      transactions.push(log);
      return work(client(log));
    },
  };
  return { database, transactions };
};

const feed = (answers: Record<string, unknown>) => ({
  apis,
  source: (url: string): Promise<unknown> => Promise.resolve(answers[url]),
});

const both = feed({ [bachelorsUrl]: [bachelor], [mastersUrl]: [master] });

const thesisRows = (statement: Statement | undefined): unknown =>
  z
    .array(z.unknown())
    .parse(JSON.parse(z.string().parse(statement?.bindings[0])));

describe('thesis parsing', () => {
  test('splits the index number off a student and reads the day', () => {
    expect(splitStudent('216022  - Бојана  Јанческа')).toEqual({
      index: '216022',
      name: 'Бојана Јанческа',
    });
    expect(splitStudent('Без индекс')).toEqual({
      index: null,
      name: 'Без индекс',
    });
    expect(splitStudent(null)).toEqual({ index: null, name: null });
    expect(isoDate('2.11.2026')).toBe('2026-11-02');
    expect(isoDate('')).toBeNull();
    expect(isoDate('2026-11-02')).toBeNull();
    expect(isoDate('31.02.2026')).toBeNull();
    expect(isoDate('29.02.2024')).toBe('2024-02-29');
    expect(isoDate('1.13.2026')).toBeNull();
    expect(tidy('  a  b ')).toBe('a b');
    expect(tidy(' '.repeat(3))).toBeNull();
  });
});

describe('the thesis import', () => {
  test('replaces every thesis and rebuilds their staff in one transaction', async () => {
    const { database, transactions } = fakeDatabase();

    const summary = await runThesisImport({}, database, both);

    expect(summary).toEqual({
      bachelors: 1,
      committee: 10,
      masters: 1,
      unmatched: [{ name: 'Тони Јаневски', theses: 9 }],
    });
    expect(transactions).toHaveLength(1);

    const sqls = transactions[0]?.map(({ sql }) => sql);

    expect(sqls).toEqual([
      thesisLockSql,
      openGuardSql('bachelor_theses'),
      storedCountSql(bachelorTable),
      clearCommitteeSql(bachelorTable),
      clearThesesSql(bachelorTable),
      insertThesesSql(bachelorTable),
      storedCountSql(masterTable),
      clearCommitteeSql(masterTable),
      clearThesesSql(masterTable),
      insertThesesSql(masterTable),
      thesisLockSql,
      openGuardSql('bachelor_thesis_staff'),
      clearCommitteeSql(bachelorTable),
      insertCommitteeSql(bachelorTable),
      clearCommitteeSql(masterTable),
      insertCommitteeSql(masterTable),
      unmatchedNamesSql,
    ]);
    expect(thesisRows(transactions[0]?.[5])).toEqual([
      {
        description: 'Апстракт',
        file_id: '9850',
        member_1: 'Георгина Мирчева',
        member_2: 'Магдалена Костоска',
        mentor: 'Игор Мишковски',
        status: 'Одбрана',
        student_index: '216022',
        student_name: 'Бојана Јанческа',
        submitted: '2026-11-02',
        title: 'Наслов',
      },
    ]);
    expect(thesisRows(transactions[0]?.[9])).toEqual([
      {
        description: 'Abstract',
        file_id: '1461',
        member: 'Игор Мишковски',
        mentor: 'Ристе Стојанов',
        presented: null,
        president: 'Костадин Мишев',
        status: '24. Магистерската е завршена.',
        student_index: '1234',
        student_name: 'Ана Петрова',
        title: 'Title',
      },
    ]);
  });

  test('refuses an unexpected or empty list and writes nothing', async () => {
    const { database, transactions } = fakeDatabase();

    await expect(
      runThesisImport(
        {},
        database,
        feed({ [bachelorsUrl]: [], [mastersUrl]: [master] }),
      ),
    ).rejects.toMatchObject({ code: 'THESES_INVALID' });
    await expect(
      runThesisImport(
        {},
        database,
        feed({ [bachelorsUrl]: { error: 'down' }, [mastersUrl]: [master] }),
      ),
    ).rejects.toBeInstanceOf(ThesisImportError);
    expect(transactions).toEqual([]);
  });

  test('refuses a list shorter than the stored theses unless the run accepts it', async () => {
    const { database, transactions } = fakeDatabase(2);

    await expect(runThesisImport({}, database, both)).rejects.toMatchObject({
      code: 'THESES_SHRANK',
      message: 'bachelor_theses: 1 listed, 2 stored',
    });
    expect(
      transactions[0]?.some(({ sql }) => sql.startsWith('DELETE')),
    ).toBeFalsy();

    // An unticked box renders the Flow's template as ''.
    await expect(
      runThesisImport({ shrink: '' }, database, both),
    ).rejects.toMatchObject({ code: 'THESES_SHRANK' });
    await expect(
      runThesisImport({ shrink: 'true' }, database, both),
    ).resolves.toMatchObject({ bachelors: 1, masters: 1 });
    expect(
      transactions[2]?.some(({ sql }) => sql.startsWith('SELECT count(*)')),
    ).toBeFalsy();
  });

  test('matches committee names to staff as the timetables do', () => {
    const bachelorSql = insertCommitteeSql(bachelorTable);

    expect(bachelorSql).toContain(
      staffResolvedSql(
        `SELECT DISTINCT "name" AS "teacher", lower(regexp_replace(btrim("name"), '\\s+', ' ', 'g')) AS "key" FROM thesis_names`,
      ),
    );
    expect(bachelorSql).toContain(`INSERT INTO "bachelor_thesis_staff"`);
    expect(bachelorSql).toContain(
      `('mentor', t."mentor"), ('member', t."member_1"), ('member', t."member_2")`,
    );
    expect(insertCommitteeSql(masterTable)).toContain(
      `('mentor', t."mentor"), ('president', t."president"), ('member', t."member")`,
    );
    expect(unmatchedNamesSql).toContain('FROM "bachelor_theses" t');
    expect(unmatchedNamesSql).toContain('FROM "master_theses" t');
  });
});

describe('the theses API source', () => {
  test('answers the JSON and refuses a failed request', async () => {
    const ok = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json([bachelor])),
    );
    const failed = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('', { status: 503 })),
    );

    await expect(httpThesisSource(ok)(bachelorsUrl)).resolves.toEqual([
      bachelor,
    ]);
    await expect(httpThesisSource(failed)(bachelorsUrl)).rejects.toMatchObject({
      code: 'THESES_API_FAILED',
    });

    const unreachable = vi.fn<typeof fetch>(() =>
      Promise.reject(new TypeError('fetch failed')),
    );

    await expect(
      httpThesisSource(unreachable)(bachelorsUrl),
    ).rejects.toMatchObject({ code: 'THESES_API_FAILED' });
  });
});

describe('the thesis staff rebuild', () => {
  test('rebuilds after every item write to staff or its aliases', () => {
    const events: string[] = [];
    registerThesisRebuild(
      (event) => {
        events.push(event);
      },
      fakeDatabase().database,
      { error: vi.fn<() => void>() },
    );

    expect(events).toEqual(thesisInputs.flatMap(eventsOf));
  });
});

describe('the thesis import Flows and keys', () => {
  test('offer the import on the dashboard and run it daily', () => {
    expect(thesisImportFlow.trigger).toBe('manual');
    expect(thesisScheduleFlow.options).toEqual({ cron: thesisImportCron });
    expect(thesisImportCron).toBe('0 0 5 * * *');
  });

  test('keep one row per thesis, staff member and role', () => {
    expect(thesisKeys.map(keyText)).toEqual([
      'unique bachelor_thesis_staff (thesis, staff, role)',
      'index bachelor_thesis_staff (staff)',
      'unique master_thesis_staff (thesis, staff, role)',
      'index master_thesis_staff (staff)',
    ]);
  });
});
