import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, test } from 'vitest';

import { decideClaim } from '../directus/extensions/directus-extension-data-operations/src/coordination/decisions.js';
import { runSnapshotImport } from '../directus/extensions/directus-extension-data-operations/src/snapshot-import.js';
import { runSnapshotPromotion } from '../directus/extensions/directus-extension-data-operations/src/snapshot-promote.js';
import {
  boundedFields,
  byteLimit,
  defaultMaxBytes,
  defaultTimeoutMs,
  durationMs,
  importOptionsSchema,
  integerFields,
  promoteOptionsSchema,
  requiredFields,
  snapshotFields,
  type SnapshotRow,
} from '../directus/extensions/directus-extension-data-operations/src/snapshot/contract.js';
import { readCsv } from '../directus/extensions/directus-extension-data-operations/src/snapshot/csv-parser.js';
import {
  fingerprintOf,
  rowText,
} from '../directus/extensions/directus-extension-data-operations/src/snapshot/fingerprint.js';
import { snapshotReport } from '../directus/extensions/directus-extension-data-operations/src/snapshot/report.js';
import {
  headerPositions,
  SnapshotRows,
  warningsOf,
} from '../directus/extensions/directus-extension-data-operations/src/snapshot/rows.js';
import { clearStagingSql } from '../directus/extensions/directus-extension-data-operations/src/snapshot/sql.js';
import {
  csvFileId,
  FakeSnapshot,
  forbiddenCaller,
  otherFileId,
  owner,
  readAll,
  refusedCallers,
  rowsOf,
  snapshotCsv,
  snapshotRow,
  syntheticRow,
} from './snapshot-import-helpers.js';

const missingIdOld = /missing ID_old/u;
const repeatedName = /repeated Name/u;
const privatePerson = /Synthetic Private Person|private@person/u;
const localStorage = /^File storage "publish", expected "local"$/u;
const snapshotFolder = /^File outside folder "Moodle snapshots \(private\)"$/u;
const mustBeCsv =
  /^File type (?:image\/png|text\/plain), expected text\/csv or a \.csv name$/u;
const overBound =
  /^File size 2000000 bytes, max 1000000 \(FINKI_HUB_SNAPSHOT_MAX_BYTES\)$/u;
const pinnedTimeout = /IMPORT_TIMEOUT: \$\{DIRECTUS_IMPORT_TIMEOUT:-15m\}/u;
// The header of the scraper's profiles.csv: the fixed contract, in order.
const scraperHeader = [
  'ID_old,ID_new,Name,Mail,Courses,Courses Count,Profile_old,Profile_new',
  'AIM_new,AIM_old,Avatar_new,Avatar_old,City_new,City_old,Country_new',
  'Country_old,Description_new,Description_old,ICQ_new,ICQ_old,Images_new',
  'Images_old,Interests_new,Interests_old,Last Access_new,Last Access_old',
  'MSN_new,MSN_old,MoodleNet_new,MoodleNet_old,Skype_new,Skype_old',
  'Timezone_new,Timezone_old,Web_new,Web_old,Yahoo_new,Yahoo_old',
].join(',');
const header = snapshotFields.join(',');
const blankCells = (count: number) => ','.repeat(count - 1);

// Data rows of a CSV whose header is the contract order, checked as the
// import checks them.
const check = async (text: string) => {
  const records = [];
  const reader = readCsv([text], { maxCellChars: 100_000, maxCells: 64 });
  for await (const record of reader) {
    records.push(record);
  }
  const [first, ...rest] = records;
  const rows = new SnapshotRows(headerPositions(first?.cells ?? []));
  const accepted = rest.map((record) => rows.accept(record));
  return { accepted, rows };
};

const line = (values: Readonly<Record<string, string>>) =>
  `${snapshotFields.map((field) => values[field] ?? '').join(',')}\n`;

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; status: number };
  }
  throw new Error('expected a refusal');
};

const importCsv = (
  world: FakeSnapshot,
  rows: ReadonlyArray<ReturnType<typeof syntheticRow>>,
) => {
  world.addFile(csvFileId, snapshotCsv(rows));
  return runSnapshotImport({ file: csvFileId }, world.deps());
};

const promote = (world: FakeSnapshot, extra: Record<string, unknown> = {}) =>
  runSnapshotPromotion(
    {
      confirm_replace: true,
      staging_fingerprint: world.data.state.fingerprint,
      ...extra,
    },
    world.deps(),
  );

// Two active users with a membership, an entry and a manual mapping, and
// a staged snapshot of three other users.
const prepared = async () => {
  const world = new FakeSnapshot();
  const previous = [syntheticRow(80), syntheticRow(81)];
  world.seedActive(previous);
  world.coordination.data.history.memberships = [
    { entry: 1, moodle_user: 1, sort: 0 },
  ];
  world.coordination.data.history.mappings = [
    { academic_year: 1, course: 1, entry: 1 },
  ];
  world.coordination.data.history.entries = [
    { first_seen: 't+1', id: 1, label: 'Synthetic Course 1' },
  ];
  const next = [syntheticRow(1), syntheticRow(2), syntheticRow(3)];
  await importCsv(world, next);
  return { next, previous, world };
};

describe('snapshot contract', () => {
  test('declares exactly the 38 scraper headers of the contract, each with its kind', () => {
    expect(snapshotFields).toHaveLength(38);
    expect(snapshotFields.join(',')).toBe(scraperHeader);
    expect(integerFields).toEqual(['ID_old', 'ID_new', 'Courses Count']);
    expect(requiredFields).toEqual(['Name']);
    expect(
      snapshotFields.filter(
        (field) =>
          !boundedFields.includes(field) && !integerFields.includes(field),
      ),
    ).toEqual([
      'Courses',
      'Profile_old',
      'Profile_new',
      'Avatar_new',
      'Avatar_old',
      'Description_new',
      'Description_old',
      'Images_new',
      'Images_old',
      'Interests_new',
      'Interests_old',
      'Web_new',
      'Web_old',
    ]);
  });

  test('takes a private file id only and a confirmed promotion of a named fingerprint', () => {
    expect(importOptionsSchema.parse({ file: csvFileId })).toEqual({
      file: csvFileId,
    });

    for (const file of [
      '/directus/uploads/x.csv',
      'https://example.com/x.csv',
      'undefined',
      '',
      null,
    ]) {
      expect(importOptionsSchema.safeParse({ file }).success).toBe(false);
    }
    const fingerprint = 'a'.repeat(64);

    expect(
      promoteOptionsSchema.parse({
        confirm_replace: 'true',
        staging_fingerprint: fingerprint,
      }),
    ).toEqual({
      allow_empty: false,
      confirm_replace: true,
      staging_fingerprint: fingerprint,
    });
    expect(
      promoteOptionsSchema.parse({
        allow_empty: 'undefined',
        confirm_replace: true,
        staging_fingerprint: fingerprint,
      }).allow_empty,
    ).toBe(false);

    for (const confirm of [false, 'false', 'undefined', null, 'yes']) {
      expect(
        promoteOptionsSchema.safeParse({
          confirm_replace: confirm,
          staging_fingerprint: fingerprint,
        }).success,
      ).toBe(false);
    }

    expect(
      promoteOptionsSchema.safeParse({
        confirm_replace: true,
        staging_fingerprint: 'A'.repeat(64),
      }).success,
    ).toBe(false);
  });

  test('pins IMPORT_TIMEOUT in the compose file and keeps the 10mb body limit', async () => {
    const compose = await readFile('compose.yaml', 'utf8');

    expect(compose).toMatch(pinnedTimeout);
    expect(compose).toContain('MAX_PAYLOAD_SIZE: 10mb');
    expect(durationMs('15m')).toBe(900_000);
  });

  test('reads IMPORT_TIMEOUT and the byte bound with documented defaults', () => {
    expect(durationMs('10m')).toBe(600_000);
    expect(durationMs('1h')).toBe(3_600_000);
    expect(durationMs('45s')).toBe(45_000);
    expect(durationMs(5_000)).toBe(5_000);
    expect(durationMs('soon')).toBe(defaultTimeoutMs);
    expect(durationMs(undefined)).toBe(defaultTimeoutMs);
    expect(byteLimit('1000')).toBe(1_000);
    expect(byteLimit(undefined)).toBe(defaultMaxBytes);
    expect(byteLimit('-5')).toBe(defaultMaxBytes);
  });
});

describe('snapshot rows', () => {
  test('requires the exact header set in any order and refuses the internal id', async () => {
    const reversed = snapshotFields.toReversed();

    expect(headerPositions(reversed)).toEqual(
      snapshotFields.map((_, index) => 37 - index),
    );
    expect(() => headerPositions(snapshotFields.slice(1))).toThrow(
      missingIdOld,
    );
    expect(() => headerPositions([...snapshotFields, 'Name'])).toThrow(
      repeatedName,
    );

    const injected = await errorOf(
      check(`id,${header}\n1,${blankCells(38)}\n`),
    );

    expect(injected.code).toBe('SNAPSHOT_INVALID_HEADERS');
    expect(injected.message).toBe(
      'Invalid header: unexpected columns: 1 (includes id)',
    );

    // A file without a header row puts a person's data there; the refusal
    // never repeats it.
    const headless = await errorOf(
      check(
        `7,8,Synthetic Private Person,private@person.example${blankCells(35)}\n`,
      ),
    );

    expect(headless.message).not.toMatch(privatePerson);
  });

  test('validates each instance id on its own and never matches across the columns', async () => {
    const { accepted, rows } = await check(
      `${header}\n${[
        line({ ID_new: '5', ID_old: '7', Name: 'A' }),
        line({ ID_new: '7', ID_old: '5', Name: 'B' }),
        line({ ID_new: '', ID_old: '', Name: 'C' }),
        line({ Name: 'D' }),
      ].join('')}`,
    );

    expect(rows.problems).toBe(0);
    expect(accepted.map((row) => row?.slice(0, 3))).toEqual([
      [7, 5, 'A'],
      [5, 7, 'B'],
      [null, null, 'C'],
      [null, null, 'D'],
    ]);

    for (const bad of [
      '0',
      '-1',
      '1.0',
      '007',
      'abc',
      '2147483648',
      ' 3',
      '1e3',
    ]) {
      const outcome = await check(
        `${header}\n${line({ ID_old: bad, Name: 'X' })}`,
      );

      expect(outcome.rows.problems).toBe(1);
      expect(outcome.rows.describe()).toContain(
        'ID_old is not a positive integer id',
      );
      expect(outcome.rows.describe()).not.toContain(`${bad} `);
    }
    const duplicated = await check(
      `${header}\n${[
        line({ ID_new: '1', ID_old: '9', Name: 'A' }),
        line({ ID_new: '2', ID_old: '9', Name: 'B' }),
        line({ ID_new: '2', ID_old: '8', Name: 'C' }),
      ].join('')}`,
    );

    expect(duplicated.rows.problems).toBe(2);
    expect(duplicated.rows.describe()).toContain(
      'row 2 (line 3) ID_old repeats the id of row 1',
    );
    expect(duplicated.rows.describe()).toContain(
      'row 3 (line 4) ID_new repeats the id of row 2',
    );
    expect(duplicated.rows.describe()).toBe(
      'Invalid rows: 2 problems in 3 rows: row 2 (line 3) ID_old repeats the id of row 1; row 3 (line 4) ID_new repeats the id of row 2',
    );
  });

  test('requires a Name, bounds the varchar columns in characters and counts every problem', async () => {
    const { rows } = await check(
      `${header}\n${[
        line({ Name: '' }),
        line({ Name: '""' }),
        line({ Mail: 'm'.repeat(256), Name: 'Long mail' }),
        line({ Mail: '😀'.repeat(255), Name: 'Emoji mail' }),
        line({ 'Courses Count': '-1', Name: 'Negative' }),
        '1,2,Short row\n',
      ].join('')}`,
    );

    expect(rows.problems).toBe(5);
    expect(rows.shown.map(({ field, row }) => [row, field])).toEqual([
      [1, 'Name'],
      [2, 'Name'],
      [3, 'Mail'],
      [5, 'Courses Count'],
      [6, null],
    ]);
  });

  test('flags a history line the index cannot hold and keeps it unchanged', async () => {
    const long = 'Ж'.repeat(1_025);
    const quotedHistory = ['"Short', long].join('\n').concat('"');
    const { accepted, rows } = await check(
      [
        `${header}\n`,
        line({ Courses: quotedHistory, Name: 'Flagged' }),
        line({ Courses: 'Fine', Name: 'Fine' }),
      ].join(''),
    );

    expect(rows.problems).toBe(0);
    expect(accepted[0]?.[4]).toBe(`Short\n${long}`);
    expect(warningsOf(rows)).toEqual({
      historyLinesOverLimit: { count: 1, rows: [1] },
    });
  });
});

describe('snapshot fingerprint', () => {
  test('renders rows like json_build_array and fingerprints them in row order', () => {
    const row = snapshotRow({
      ID_new: 1,
      Name: String.raw`a"b\c`,
      Profile_new: 'x\ny\u{1}z',
      Web_old: 'Ж😀',
    });

    expect(
      rowText(row).startsWith(String.raw`[null, 1, "a\"b\\c", null, null, `),
    ).toBeTruthy();
    expect(rowText(row)).toContain(String.raw`"x\ny\u0001z"`);

    const rows = [syntheticRow(1), syntheticRow(2)];

    expect(fingerprintOf(rows)).toBe(fingerprintOf([...rows]));
    expect(fingerprintOf(rows)).not.toBe(fingerprintOf(rows.toReversed()));
    expect(fingerprintOf([])).toBe(
      createHash('sha256').update('').digest('hex'),
    );

    const digests = rows.map((value) =>
      createHash('sha256').update(rowText(value)).digest('hex'),
    );

    expect(fingerprintOf(rows)).toBe(
      createHash('sha256').update(digests.join('')).digest('hex'),
    );
  });
});

describe('snapshot import operation', () => {
  test('refuses a refused caller before anything is read or written', async () => {
    const world = new FakeSnapshot();
    world.addFile(csvFileId, snapshotCsv([syntheticRow(1)]));
    for (const [accountability, refusal] of refusedCallers) {
      await expect(
        runSnapshotImport({ file: csvFileId }, world.deps({ accountability })),
      ).rejects.toMatchObject(refusal);
    }

    expect(world.coordination.transactions).toBe(0);
    expect(world.data.state.state).toBe('idle');
  });

  test('stages every raw value and answers ready only once staging committed', async () => {
    const world = new FakeSnapshot();
    world.seedActive([syntheticRow(90)]);
    const tricky = snapshotRow({
      Courses: 'Line one\r\nLine two',
      Description_new: '[Skopje]',
      Description_old: '{"a": 1}',
      ID_new: 1,
      Interests_new: 'true',
      Interests_old: '  padded  ',
      Name: '"Quoted" Name',
      Profile_old: 'null',
      Web_new: '',
    });
    const rows = [tricky, syntheticRow(2), syntheticRow(3)];
    const revision = world.coordination.data.sourceRevision;
    const result = await importCsv(world, rows);

    expect(result).toEqual({
      file: csvFileId,
      fingerprint: fingerprintOf(rows),
      rows: 3,
      state: 'ready',
      warnings: null,
    });
    expect(rowsOf(world.data.staging)).toEqual(rows);
    expect(world.stateLog).toEqual(['importing', 'validating', 'ready']);
    expect(world.data.state).toMatchObject({
      file: csvFileId,
      fingerprint: result.fingerprint,
      rows: 3,
      state: 'ready',
    });
    expect(rowsOf(world.data.active)).toEqual([syntheticRow(90)]);
    expect(world.coordination.data.sourceRevision).toBe(revision);
    expect(world.coordination.data.dirtyDomains).toEqual([]);
  });

  test('refuses id injection, a late malformed row and broken CSV, keeping staging and active rows', async () => {
    const world = new FakeSnapshot();
    world.seedActive([syntheticRow(90)]);
    await importCsv(world, [syntheticRow(1)]);
    const staged = structuredClone(world.data.staging);
    const valid = snapshotCsv([
      syntheticRow(2),
      syntheticRow(3),
      syntheticRow(4),
    ]);
    const cases: Array<[string, string]> = [
      [`id,${header}\n1,${blankCells(38)}\n`, 'SNAPSHOT_INVALID_HEADERS'],
      [
        `${valid}${line({ ID_new: 'abc', Name: 'Late' })}`,
        'SNAPSHOT_INVALID_ROWS',
      ],
      [
        `${valid}${line({ ID_new: '10002', Name: 'Late duplicate' })}`,
        'SNAPSHOT_INVALID_ROWS',
      ],
      [`${valid}1,2,"Open quote${blankCells(36)}\n`, 'SNAPSHOT_INVALID_CSV'],
      [`${valid}1,2,Extra${blankCells(38)}\n`, 'SNAPSHOT_INVALID_ROWS'],
      ['', 'SNAPSHOT_INVALID_HEADERS'],
    ];
    for (const [content, code] of cases) {
      world.addFile(otherFileId, content);
      const refusal = await errorOf(
        runSnapshotImport({ file: otherFileId }, world.deps()),
      );

      expect(refusal.code).toBe(code);
      expect(world.data.state.state).toBe('failed');
      expect(world.data.state.error).toContain(code);
      expect(world.data.state.error).not.toContain('Late');
      expect(world.data.staging).toEqual(staged);
      expect(rowsOf(world.data.active)).toEqual([syntheticRow(90)]);
    }

    expect(world.data.state.error).toBe(
      'SNAPSHOT_INVALID_HEADERS: File empty: no header row',
    );
  });

  test('sends a staging batch after 250 rows or once its cells reach the character budget', async () => {
    const world = new FakeSnapshot();
    const long = Array.from({ length: 6 }, (_, index) =>
      snapshotRow({
        Description_new: 'x'.repeat(1_048_576),
        ID_new: 20_000 + index,
        Name: `Synthetic Long ${index}`,
      }),
    );
    world.addFile(csvFileId, snapshotCsv(long));
    const deps = world.deps({
      limits: { heartbeatMs: 0, maxBytes: 20_000_000, timeoutMs: 60_000 },
    });

    await expect(
      runSnapshotImport({ file: csvFileId }, deps),
    ).resolves.toMatchObject({ fingerprint: fingerprintOf(long), rows: 6 });
    expect(world.batches).toEqual([4, 2]);
    expect(rowsOf(world.data.staging)).toEqual(long);

    const small = Array.from({ length: 600 }, (_, index) =>
      syntheticRow(index),
    );
    world.batches.length = 0;
    await importCsv(world, small);

    expect(world.batches).toEqual([250, 250, 100]);
    // A DELETE, never TRUNCATE: readers keep the committed staging.
    expect(clearStagingSql).toBe('DELETE FROM "moodle_import_rows"');
  });

  test('keeps the promoted identity through later imports, so outside edits stay visible', async () => {
    const fresh = new FakeSnapshot();

    await expect(snapshotReport(fresh.store)).resolves.toMatchObject({
      activeMatchesPromotion: null,
      promoted: null,
    });

    const { next, world } = await prepared();
    await promote(world);
    const report = () => snapshotReport(world.store);

    await expect(report()).resolves.toMatchObject({
      activeMatchesPromotion: true,
      promoted: { fingerprint: fingerprintOf(next), rows: 3 },
    });

    // A failed transaction of the fake restores a copy of its data, so the
    // first active row is looked up again for every edit.
    const editFirst = (row: SnapshotRow) => {
      const [first] = world.data.active;
      if (first === undefined) {
        throw new Error('no active row');
      }
      first.row = row;
    };
    editFirst(snapshotRow({ Name: 'Synthetic Outside Edit' }));

    await expect(report()).resolves.toMatchObject({
      activeMatchesPromotion: false,
    });

    world.addFile(otherFileId, 'Synthetic,Not,A,Snapshot\n');
    await errorOf(runSnapshotImport({ file: otherFileId }, world.deps()));

    await expect(report()).resolves.toMatchObject({
      activeMatchesPromotion: false,
      fingerprint: null,
      state: 'failed',
    });

    await importCsv(world, [syntheticRow(9)]);

    await expect(report()).resolves.toMatchObject({
      activeMatchesPromotion: false,
      promoted: { fingerprint: fingerprintOf(next), rows: 3 },
      state: 'ready',
    });

    editFirst(next[0] ?? []);

    await expect(report()).resolves.toMatchObject({
      activeMatchesPromotion: true,
    });
  });

  test('never answers ready when the database staged other values than the file holds', async () => {
    const world = new FakeSnapshot();
    world.hooks.stored = (row) =>
      row.map((value) =>
        value === 'Synthetic User 2' ? 'Synthetic User 2 ' : value,
      );
    const refusal = await errorOf(
      importCsv(world, [syntheticRow(1), syntheticRow(2)]),
    );

    expect(refusal.code).toBe('SNAPSHOT_COUNT_MISMATCH');
    expect(world.data.state.state).toBe('failed');
    expect(world.data.staging).toEqual([]);
  });
});

describe('snapshot import guards', () => {
  test('refuses files outside private local storage, of another type or over the bound', async () => {
    const world = new FakeSnapshot();
    const content = snapshotCsv([syntheticRow(1)]);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ storage: 'publish' }, localStorage],
      [{ folder: null }, snapshotFolder],
      [{ folder: otherFileId }, snapshotFolder],
      [{ filename: 'photo.png', type: 'image/png' }, mustBeCsv],
      [{ filename: 'export.txt', type: 'text/plain' }, mustBeCsv],
      [{ size: 2_000_000 }, overBound],
    ];
    for (const [facts, message] of cases) {
      world.addFile(csvFileId, content, facts);
      const refusal = await errorOf(
        runSnapshotImport({ file: csvFileId }, world.deps()),
      );

      expect(refusal.code).toBe('SNAPSHOT_FILE_INVALID');
      expect(refusal.message).toMatch(message);
    }
    world.addFile(csvFileId, content, {
      filename: 'Export.CSV',
      type: 'application/vnd.ms-excel',
    });

    await expect(
      runSnapshotImport({ file: csvFileId }, world.deps()),
    ).resolves.toMatchObject({ rows: 1 });

    const missing = await errorOf(
      runSnapshotImport({ file: otherFileId }, world.deps()),
    );

    expect(missing.message).toBe('File not found');
  });

  test('runs one import at a time and takes over a dead one', async () => {
    const world = new FakeSnapshot();
    world.addFile(csvFileId, snapshotCsv([syntheticRow(1)]));
    world.setState({
      startedAgeMs: 1_000,
      state: 'importing',
      token: 'running',
    });
    const running = await errorOf(
      runSnapshotImport({ file: csvFileId }, world.deps()),
    );

    expect(running.code).toBe('SNAPSHOT_IMPORT_RUNNING');

    world.setState({ startedAgeMs: 60_000 + 60_001, state: 'validating' });

    await expect(
      runSnapshotImport({ file: csvFileId }, world.deps()),
    ).resolves.toMatchObject({ state: 'ready' });

    world.setState({ state: 'promoting' });
    await world.store.transaction(({ coordination }) =>
      coordination.takeClaim({
        dirtyDomains: [],
        domain: 'snapshot',
        fingerprint: 'graph-a',
        owner,
        sourceRevision: 0,
        token: 'claim',
      }),
    );
    const promoting = await errorOf(
      runSnapshotImport({ file: csvFileId }, world.deps()),
    );

    expect(promoting.code).toBe('SNAPSHOT_PROMOTION_RUNNING');
  });

  test('stops at IMPORT_TIMEOUT and reports it', async () => {
    const world = new FakeSnapshot();
    world.addFile(csvFileId, '');
    const deps = world.deps({
      limits: { heartbeatMs: 0, maxBytes: 1_000_000, timeoutMs: 5 },
    });
    const slow = {
      ...deps,
      files: {
        ...deps.files,
        open: async () =>
          (async function* () {
            yield `${header}\n`;
            await delay(30);
            yield line({ Name: 'Late' });
          })(),
      },
    };
    const refusal = await errorOf(runSnapshotImport({ file: csvFileId }, slow));

    expect(refusal.code).toBe('SNAPSHOT_IMPORT_TIMEOUT');
    expect(world.data.state.error).toContain('IMPORT_TIMEOUT');
  });
});

describe('snapshot promotion operation', () => {
  test('replaces the active snapshot after a verified backup, under the snapshot claim, in one step', async () => {
    const { next, previous, world } = await prepared();
    const revision = world.coordination.data.sourceRevision;
    const result = await promote(world);

    expect(rowsOf(world.data.active)).toEqual(next);
    expect(world.data.active.map(({ id }) => id)).toEqual([3, 4, 5]);
    expect(world.data.staging).toEqual([]);
    expect(world.coordination.data.history.memberships).toEqual([]);
    expect(world.coordination.data.history.mappings).toHaveLength(1);
    expect(world.coordination.data.history.entries).toHaveLength(1);
    expect(world.coordination.data.claim).toBeNull();
    expect(world.coordination.data.dirtyDomains).toEqual([
      'history_index',
      'enrollments',
      'publication',
    ]);
    expect(world.coordination.data.sourceRevision).toBe(revision + 2);
    expect(world.data.state).toMatchObject({
      backupRows: 2,
      state: 'completed',
    });
    expect(world.stateLog.slice(-2)).toEqual(['promoting', 'completed']);
    expect(result).toMatchObject({
      membershipsRemoved: 1,
      pending: ['history_index', 'enrollments', 'publication'],
      previousRows: 2,
      revision: revision + 2,
      rows: 3,
      state: 'completed',
    });

    const backup = world.data.uploads.get(result.backup.file) ?? '';

    expect(result.backup).toMatchObject({
      fingerprint: fingerprintOf(previous),
      rows: 2,
    });
    expect(backup).toBe(snapshotCsv(previous));

    world.addFile(otherFileId, await readAll([backup]));
    const restored = await runSnapshotImport(
      { file: otherFileId },
      world.deps(),
    );

    expect(restored.fingerprint).toBe(fingerprintOf(previous));
  });

  test('needs the confirmed fingerprint and a separate confirmation for an empty snapshot', async () => {
    const { previous, world } = await prepared();
    const wrong = await errorOf(
      promote(world, { staging_fingerprint: 'b'.repeat(64) }),
    );

    expect(wrong.code).toBe('SNAPSHOT_FINGERPRINT_MISMATCH');

    const unconfirmed = await errorOf(
      promote(world, { confirm_replace: false }),
    );

    expect(unconfirmed.code).toBe('SNAPSHOT_INVALID_OPTIONS');

    await importCsv(world, []);
    const empty = await errorOf(promote(world));

    expect(empty.code).toBe('SNAPSHOT_EMPTY_NOT_CONFIRMED');
    expect(world.data.state.state).toBe('ready');
    expect(world.data.uploads.size).toBe(0);
    expect(rowsOf(world.data.active)).toEqual(previous);
    await expect(promote(world, { allow_empty: true })).resolves.toMatchObject({
      rows: 0,
      previousRows: 2,
    });
    expect(world.data.active).toEqual([]);
  });

  test('refuses while another data operation holds the claim, and a refused caller', async () => {
    const { previous, world } = await prepared();
    await world.store.transaction(({ coordination }) =>
      coordination.takeClaim({
        dirtyDomains: ['history_index'],
        domain: 'history_index',
        fingerprint: 'graph-a',
        owner,
        sourceRevision: 0,
        token: 'other',
      }),
    );
    const busy = await errorOf(promote(world));

    expect(busy.code).toBe('SNAPSHOT_CLAIM_BUSY');

    world.coordination.data.claim = null;
    const forbidden = await errorOf(
      runSnapshotPromotion(
        {
          confirm_replace: true,
          staging_fingerprint: world.data.state.fingerprint,
        },
        world.deps({ accountability: { admin: false, user: 'u' } }),
      ),
    );

    expect(forbidden).toMatchObject(forbiddenCaller);
    expect(rowsOf(world.data.active)).toEqual(previous);
    expect(world.data.state.state).toBe('ready');
  });
});

describe('snapshot promotion failures', () => {
  test('leaves active users, memberships and revisions untouched when the replacement fails', async () => {
    const { previous, world } = await prepared();
    const revision = world.coordination.data.sourceRevision;
    world.hooks.replaceInserts = (staged) => staged - 1;
    const short = await errorOf(promote(world));

    expect(short.code).toBe('SNAPSHOT_COUNT_MISMATCH');
    expect(rowsOf(world.data.active)).toEqual(previous);
    expect(world.data.staging).toHaveLength(3);
    expect(world.coordination.data.history.memberships).toHaveLength(1);
    expect(world.coordination.data.sourceRevision).toBe(revision);
    expect(world.coordination.data.claim).toBeNull();
    // The failure is the promotion's own: import_state and import_error,
    // never the coordinator's failure slot of the work domains.
    expect(world.coordination.data.lastError).toBeNull();
    expect(world.data.state).toMatchObject({ state: 'failed' });
    expect(world.data.state.error).toContain('SNAPSHOT_COUNT_MISMATCH');
  });

  test('never lifts the explicit retry of a failed work domain when it fails itself', async () => {
    const { world } = await prepared();
    const { coordination } = world;
    coordination.data.calculationFingerprint = coordination.graphs.calculation;
    coordination.data.dirtyDomains = ['publication'];
    await world.store.transaction(({ coordination: port }) =>
      port.takeClaim({
        dirtyDomains: ['publication'],
        domain: 'publication',
        fingerprint: coordination.graphs.publication,
        owner,
        sourceRevision: coordination.data.sourceRevision,
        token: 'publish',
      }),
    );
    await world.store.transaction(({ coordination: port }) =>
      port.release({
        code: 'SYNTHETIC_PUBLISH_FAILURE',
        failed: true,
        token: 'publish',
      }),
    );
    const publication = async () =>
      decideClaim(
        await world.store.transaction(({ coordination: port }) =>
          port.readState(false),
        ),
        {
          currentFingerprints: coordination.graphs,
          domain: 'publication',
          retry: false,
        },
      ).kind;
    const failedBefore = structuredClone(coordination.data.lastError);

    await expect(publication()).resolves.toBe('failed');

    world.hooks.corruptUpload = (text) => `${text}"Synthetic Extra"\r\n`;
    const backup = await errorOf(promote(world));

    expect(backup.code).toBe('SNAPSHOT_BACKUP_FAILED');
    expect(coordination.data.lastError).toEqual(failedBefore);
    await expect(publication()).resolves.toBe('failed');
    expect(world.data.state.error).toContain('SNAPSHOT_BACKUP_FAILED');
  });

  test('keeps its claim alive through a long backup and stops as soon as the claim is lost', async () => {
    const world = new FakeSnapshot();
    const many = (from: number) =>
      Array.from({ length: 1_200 }, (_, index) => syntheticRow(from + index));
    world.seedActive(many(5_000));
    await importCsv(world, many(1));
    // Another process's recovery runs before every export batch while
    // 40 s pass each time; without heartbeats the claim would be stale
    // (60 s) by the second batch.
    world.hooks.exportBatch = () => {
      world.coordination.advance(40_000);
      world.coordination.recoverOutside(60_000);
    };

    await expect(promote(world)).resolves.toMatchObject({
      previousRows: 1_200,
      rows: 1_200,
    });

    await importCsv(world, [syntheticRow(1)]);
    let exported = 0;
    world.hooks.exportBatch = () => {
      exported += 1;
      world.coordination.advance(70_000);
      world.coordination.recoverOutside(60_000);
    };
    const lost = await errorOf(promote(world));

    expect(lost.code).toBe('SNAPSHOT_CLAIM_LOST');
    expect(exported).toBe(1);
    expect(world.data.active).toHaveLength(1_200);
    expect(world.data.state.state).toBe('failed');
    expect(world.coordination.data.claim).toBeNull();
    expect(world.coordination.data.lastError).toBeNull();
  });

  test('logs only value-free facts of an unexpected failure and reports a cancelled statement as IMPORT_TIMEOUT', async () => {
    const { previous, world } = await prepared();
    world.hooks.replaceInserts = () => {
      throw Object.assign(
        new Error(
          'null value in column "Timezone_new" violates not-null constraint (Synthetic Private Person)',
        ),
        {
          code: '23502',
          column: 'Timezone_new',
          detail: 'Failing row contains (Synthetic Private Person).',
          table: 'moodle_users',
        },
      );
    };
    const failed = await errorOf(promote(world));

    expect(failed.code).toBe('SNAPSHOT_PROMOTION_FAILED');
    expect(failed.message).toBe('Unexpected error (code: 23502)');
    expect(failed.message).not.toMatch(privatePerson);
    expect(world.logs).toEqual([
      {
        details: {
          cause: {
            code: '23502',
            column: 'Timezone_new',
            name: 'Error',
            table: 'moodle_users',
          },
          code: 'SNAPSHOT_PROMOTION_FAILED',
          operation: 'promotion',
        },
        message: 'Snapshot promotion failed: SNAPSHOT_PROMOTION_FAILED',
      },
    ]);
    expect(JSON.stringify(world.logs)).not.toMatch(privatePerson);

    await importCsv(world, [syntheticRow(4)]);
    world.hooks.replaceInserts = () => {
      throw Object.assign(
        new Error('canceling statement due to statement timeout'),
        { code: '57014' },
      );
    };
    const cancelled = await errorOf(promote(world));

    expect(cancelled.code).toBe('SNAPSHOT_IMPORT_TIMEOUT');
    expect(cancelled.message).toBe(
      'Statement cancelled: statement_timeout (IMPORT_TIMEOUT) or manual cancel',
    );
    expect(cancelled.status).toBe(408);
    expect(rowsOf(world.data.active)).toEqual(previous);
  });

  test('refuses a stored backup that does not match, and active rows changed after it', async () => {
    const { previous, world } = await prepared();
    world.hooks.corruptUpload = (text) =>
      text.replace('Synthetic User 81', 'Synthetic User 8I');
    const corrupt = await errorOf(promote(world));

    expect(corrupt.code).toBe('SNAPSHOT_BACKUP_FAILED');
    expect(rowsOf(world.data.active)).toEqual(previous);
    expect(world.coordination.data.claim).toBeNull();
    expect(world.data.state.state).toBe('failed');

    world.hooks.corruptUpload = undefined;
    await importCsv(world, [syntheticRow(5)]);
    // A concurrent edit of one Moodle user commits right after the backup:
    // the row count stays, the content does not.
    const edited = snapshotRow({ ID_new: 10_080, Name: 'Synthetic Edited' });
    world.hooks.afterUpload = () => {
      const [first] = world.data.active;
      if (first !== undefined) {
        first.row = edited;
      }
    };
    const changed = await errorOf(promote(world));

    expect(changed.code).toBe('SNAPSHOT_ACTIVE_CHANGED');
    expect(rowsOf(world.data.active)).toEqual([edited, previous[1]]);
    expect(world.data.staging).toHaveLength(1);
    expect(world.data.state.state).toBe('failed');
  });
});
