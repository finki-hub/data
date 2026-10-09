import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';

import packageJson from '../package.json' with { type: 'json' };
import { exitCodes } from '../src/lifecycle.js';
import { compareLive } from '../src/live-check/compare.js';
import {
  type Fetch,
  fetchLiveFiles,
  type LiveData,
  type PublicRow,
} from '../src/live-check/fetch.js';
import { runLiveCheck } from '../src/live-check/run.js';
import { expectedRows } from './expected-exports.js';
import {
  courseNames,
  type SyntheticDataset,
} from './fixtures/synthetic-data.js';
import {
  lifecycleDataset,
  syntheticWorkbook,
} from './fixtures/synthetic-workbook.js';
import { withCourse } from './import-plan-helpers.js';
import { parityDataset } from './relational-export-helpers.js';

const sentinel = 'SENTINEL_PRIVATE_VALUE';

const course = (name: string, values: Record<string, string> = {}) => ({
  name,
  professors: 'Prof. Synthetic',
  '2025/2026': '10',
  '2024/2025': '20',
  '2023-available': 'TRUE',
  ...values,
});

const files = ({
  courses = [],
  rooms = [],
  staff = [],
}: {
  readonly courses?: readonly PublicRow[];
  readonly rooms?: readonly PublicRow[];
  readonly staff?: readonly PublicRow[];
}) => ({ 'courses.json': courses, 'rooms.json': rooms, 'staff.json': staff });

const noPlaces = { 'rooms.json': [], 'staff.json': [] };

describe('courses.json compared with live', () => {
  test('pairs rows by name in any order and reports nothing for equal data', () => {
    const rows = [course('Alpha'), course('Beta')];
    const report = compareLive({
      live: files({ courses: rows.toReversed() }),
      places: noPlaces,
      projected: files({ courses: rows }),
      yearsCompared: true,
    });

    expect(report['courses.json']).toEqual({
      differingValues: 0,
      duplicateKeys: { live: [], projected: [] },
      keys: {},
      notCompared: [],
      onlyLive: [],
      onlyProjected: [],
      rows: { live: 2, matched: 2, projected: 2 },
    });
  });

  test('lists per key the courses whose value differs, is live only or projected only', () => {
    const report = compareLive({
      live: files({
        courses: [
          course('Alpha', { professors: `${sentinel} live` }),
          course('Beta', { assistants: sentinel }),
          course('Gamma'),
        ],
      }),
      places: noPlaces,
      projected: files({
        courses: [
          course('Alpha', { professors: `${sentinel} projected` }),
          course('Beta'),
          course('Gamma', { '2018-available': 'FALSE', assistants: 'A' }),
        ],
      }),
      yearsCompared: false,
    })['courses.json'];

    expect(report.keys).toEqual({
      '2018-available': { differs: [], liveOnly: [], projectedOnly: ['Gamma'] },
      assistants: { differs: [], liveOnly: ['Beta'], projectedOnly: ['Gamma'] },
      professors: { differs: ['Alpha'], liveOnly: [], projectedOnly: [] },
    });
    expect(report.differingValues).toBe(4);
    expect(JSON.stringify(report)).not.toContain(sentinel);
  });

  test('lists the year keys of either side under notCompared, newest first, while years are not compared', () => {
    const report = compareLive({
      live: files({ courses: [course('Alpha', { '2025/2026': '1' })] }),
      places: noPlaces,
      projected: files({
        courses: [course('Alpha', { '2026/2027': '0', '2025/2026': '0' })],
      }),
      yearsCompared: false,
    })['courses.json'];

    expect(report.notCompared).toEqual(['2026/2027', '2025/2026', '2024/2025']);
    expect(report.keys).toEqual({});
    expect(report.differingValues).toBe(0);
  });

  test('lists each course with both counts under a compared year key', () => {
    const report = compareLive({
      live: files({ courses: [course('Alpha'), course('Beta')] }),
      places: noPlaces,
      projected: files({
        courses: [
          course('Alpha', { '2025/2026': '11', '2026/2027': '5' }),
          course('Beta'),
        ],
      }),
      yearsCompared: true,
    })['courses.json'];

    expect(report.notCompared).toEqual([]);
    expect(report.keys).toEqual({
      '2025/2026': {
        differs: [
          { course: 'Alpha', live: '10', projected: '11', year: '2025/2026' },
        ],
        liveOnly: [],
        projectedOnly: [],
      },
      '2026/2027': {
        differs: [],
        liveOnly: [],
        projectedOnly: [
          { course: 'Alpha', live: null, projected: '5', year: '2026/2027' },
        ],
      },
    });
    expect(report.differingValues).toBe(2);
  });

  test('names the courses on one side only, and leaves a name that repeats on either side uncompared on both', () => {
    const report = compareLive({
      live: files({
        courses: [
          course('Alpha'),
          course('Old'),
          course('Twice'),
          course('Twice', { professors: 'X' }),
        ],
      }),
      places: noPlaces,
      projected: files({
        courses: [
          course('Alpha'),
          course('New'),
          course('Twice', { tags: 'x' }),
        ],
      }),
      yearsCompared: true,
    })['courses.json'];

    expect(report.onlyLive).toEqual(['Old']);
    expect(report.onlyProjected).toEqual(['New']);
    expect(report.duplicateKeys).toEqual({
      live: ['Twice'],
      projected: ['Twice'],
    });
    expect(report.rows).toEqual({ live: 4, matched: 1, projected: 3 });
    expect(report.keys).toEqual({});
  });
});

const staffRow = (name: string, values: Record<string, string> = {}) => ({
  name,
  active: '1',
  title: 'Prof.',
  position: 'Professor',
  email: `${name.toLowerCase().replaceAll(' ', '.')}@staff.example`,
  ...values,
});

const room = (location: string, name: string, type = 'Lab') => ({
  location,
  name,
  type,
});

describe('staff.json and rooms.json compared with live', () => {
  test('count the differences and place the projected rows, never showing a value', () => {
    const report = compareLive({
      live: files({
        staff: [
          staffRow(`${sentinel} One`, { title: `${sentinel} title` }),
          staffRow(`${sentinel} Two`),
          staffRow(`${sentinel} Live`),
          staffRow(`${sentinel} Twice`),
          staffRow(`${sentinel} Twice`),
        ],
      }),
      places: {
        'rooms.json': [],
        'staff.json': [
          'Кадар (Export) row 2',
          'Кадар (Export) row 3',
          'Кадар (Export) row 4',
          'Кадар (Export) row 5',
          'Кадар (Export) row 6',
          'Кадар (Export) row 7',
        ],
      },
      projected: files({
        staff: [
          staffRow(`${sentinel} One`),
          staffRow(`${sentinel} Two`, { cabinet: sentinel }),
          staffRow(`${sentinel} Projected`),
          staffRow(`${sentinel} Twice`),
          staffRow(`${sentinel} Again`),
          staffRow(`${sentinel} Again`, { cabinet: sentinel }),
        ],
      }),
      yearsCompared: true,
    })['staff.json'];

    expect(report).toEqual({
      differingValues: 2,
      duplicateKeys: {
        live: 2,
        projected: [
          'Кадар (Export) row 5',
          'Кадар (Export) row 6',
          'Кадар (Export) row 7',
        ],
      },
      keys: {
        cabinet: { differs: 0, liveOnly: 0, projectedOnly: 1 },
        title: { differs: 1, liveOnly: 0, projectedOnly: 0 },
      },
      onlyLive: 1,
      onlyProjected: ['Кадар (Export) row 4'],
      rows: { live: 5, matched: 2, projected: 6 },
    });
    expect(JSON.stringify(report)).not.toContain(sentinel);
  });

  test('pair rooms by location and name, because room names repeat', () => {
    const report = compareLive({
      live: files({
        rooms: [room('A', '101'), room('B', '101'), room('C', '7')],
      }),
      places: {
        'rooms.json': [
          'Простории (Export) row 2',
          'Простории (Export) row 3',
          'Простории (Export) row 4',
        ],
        'staff.json': [],
      },
      projected: files({
        rooms: [room('A', '101'), room('B', '101', 'Hall'), room('D', '7')],
      }),
      yearsCompared: true,
    })['rooms.json'];

    expect(report).toEqual({
      differingValues: 1,
      duplicateKeys: { live: 0, projected: [] },
      keys: { type: { differs: 1, liveOnly: 0, projectedOnly: 0 } },
      onlyLive: 1,
      onlyProjected: ['Простории (Export) row 4'],
      rows: { live: 3, matched: 2, projected: 3 },
    });
  });

  test('count the rooms whose location and name repeat and place the projected ones, never showing a value', () => {
    const report = compareLive({
      live: files({
        rooms: [
          room(`${sentinel} A`, `${sentinel} 101`),
          room(`${sentinel} A`, `${sentinel} 101`),
          room(`${sentinel} B`, `${sentinel} 7`),
        ],
      }),
      places: {
        'rooms.json': [
          'Простории (Export) row 2',
          'Простории (Export) row 3',
          'Простории (Export) row 4',
        ],
        'staff.json': [],
      },
      projected: files({
        rooms: [
          room(`${sentinel} B`, `${sentinel} 7`),
          room(`${sentinel} C`, `${sentinel} 9`),
          room(`${sentinel} C`, `${sentinel} 9`, sentinel),
        ],
      }),
      yearsCompared: true,
    })['rooms.json'];

    expect(report).toEqual({
      differingValues: 0,
      duplicateKeys: {
        live: 2,
        projected: ['Простории (Export) row 3', 'Простории (Export) row 4'],
      },
      keys: {},
      onlyLive: 0,
      onlyProjected: [],
      rows: { live: 3, matched: 1, projected: 3 },
    });
    expect(JSON.stringify(report)).not.toContain(sentinel);
  });
});

type FetchCall = { readonly signal: unknown; readonly url: string };

// A fetch answering each live file from `answers` by its name, recording
// every request.
const fakeFetch = (
  answers: Readonly<Record<string, () => Promise<Response>>>,
): { readonly calls: FetchCall[]; readonly fetch: Fetch } => {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ signal: init.signal, url: url.href });
      const answer = answers[url.pathname.slice(1)];
      if (answer === undefined) {
        throw new Error(`unexpected request ${url.href}`);
      }
      return answer();
    },
  };
};

const json =
  (body: unknown, status = 200) =>
  async () =>
    Response.json(body, { status });

const liveAnswers = (data: LiveData) => ({
  'courses.json': json(data['courses.json']),
  'rooms.json': json(data['rooms.json']),
  'staff.json': json(data['staff.json']),
});

describe('the live files', () => {
  test('are courses.json, staff.json and rooms.json from the public host, each with a 30 s timeout; never students.json', async () => {
    const data = files({
      courses: [course('Alpha')],
      rooms: [{ location: 'A', name: '1', type: 'Lab' }],
      staff: [staffRow('Synthetic Staff')],
    });
    const fake = fakeFetch(liveAnswers(data));
    const timeout = vi.spyOn(AbortSignal, 'timeout');

    await expect(fetchLiveFiles(fake.fetch)).resolves.toEqual(data);
    expect(fake.calls.map(({ url }) => url)).toEqual([
      'https://assets.finki-hub.com/courses.json',
      'https://assets.finki-hub.com/staff.json',
      'https://assets.finki-hub.com/rooms.json',
    ]);
    expect(timeout.mock.calls).toEqual([[30_000], [30_000], [30_000]]);
    expect(fake.calls.map(({ signal }) => signal)).toEqual(
      timeout.mock.results.map((result) =>
        result.type === 'return' ? result.value : null,
      ),
    );

    timeout.mockRestore();
  });

  test.each([
    {
      answer: json([], 503),
      message: 'courses.json: HTTP 503',
      name: 'an HTTP error',
    },
    {
      answer: json({ rows: [] }),
      message:
        'courses.json: unexpected response: Invalid input: expected array, received object',
      name: 'a body that is no list of rows',
    },
    {
      answer: json([{ name: 'Alpha', '2025/2026': 12 }]),
      message:
        'courses.json: unexpected response: 0.2025/2026: Invalid input: expected string, received number',
      name: 'a value that is no text',
    },
    {
      answer: async () => new Response('<html>', { status: 200 }),
      message: 'courses.json: invalid JSON',
      name: 'a body that is no JSON',
    },
    {
      answer: async () => {
        throw new TypeError('fetch failed', {
          cause: { code: 'ECONNREFUSED' },
        });
      },
      message: 'courses.json: no response (ECONNREFUSED)',
      name: 'no answer',
    },
    {
      answer: async () => {
        throw new DOMException('aborted', 'TimeoutError');
      },
      message: 'courses.json: timed out after 30 s',
      name: 'a timeout',
    },
  ])('fail on $name, placed at the file', async ({ answer, message }) => {
    const fake = fakeFetch({ 'courses.json': answer });

    await expect(fetchLiveFiles(fake.fetch)).rejects.toThrow(message);
  });
});

const scratch = { directory: '' };

beforeEach(async () => {
  scratch.directory = await mkdtemp(path.join(os.tmpdir(), 'live-check-'));
});

afterEach(async () => {
  await rm(scratch.directory, { force: true, recursive: true });
});

const savedDataset = async (dataset: SyntheticDataset = parityDataset()) => {
  const file = path.join(scratch.directory, 'synthetic.xlsx');
  await syntheticWorkbook(dataset).xlsx.writeFile(file);
  return file;
};

// The live files as the committed parity case states them.
const parityLive = async (): Promise<LiveData> =>
  files({
    courses: await expectedRows('parity', 'courses'),
    rooms: await expectedRows('parity', 'rooms'),
    staff: await expectedRows('parity', 'staff'),
  });

const liveCheck = (
  answers: Readonly<Record<string, () => Promise<Response>>>,
) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fake = fakeFetch(answers);
  return {
    calls: fake.calls,
    run: (
      arguments_: readonly string[],
      environment: Readonly<Record<string, string | undefined>>,
    ) =>
      runLiveCheck(arguments_, environment, {
        fetch: fake.fetch,
        stderr: (line) => {
          stderr.push(line);
        },
        stdout: (line) => {
          stdout.push(line);
        },
      }),
    stderr,
    stdout,
  };
};

const output = z.object({ workbook: z.string() }).loose();
const unreadablePattern =
  /^Live check failed: workbook \/.+\/missing\.xlsx: not readable as \.xlsx \(/u;

describe('npm run compare:live', () => {
  test('is the live check command', () => {
    const { scripts } = z
      .object({ scripts: z.record(z.string(), z.string()) })
      .parse(packageJson);

    expect(scripts['compare:live']).toBe(
      'node --import tsx src/live-check-cli.ts',
    );
  });

  test.each([
    { environment: {}, name: 'without WORKBOOK_PATH' },
    { environment: { WORKBOOK_PATH: '' }, name: 'with an empty WORKBOOK_PATH' },
  ])('refuses $name and reads nothing', async ({ environment }) => {
    const check = liveCheck({});

    await expect(check.run([], environment)).resolves.toBe(exitCodes.refused);
    expect(check.stderr).toEqual(['Live check refused: WORKBOOK_PATH not set']);
    expect(check.stdout).toEqual([]);
    expect(check.calls).toEqual([]);
  });

  test('refuses an argument', async () => {
    const check = liveCheck({});
    const workbook = await savedDataset();

    await expect(
      check.run(['--dry-run'], { WORKBOOK_PATH: workbook }),
    ).resolves.toBe(exitCodes.refused);
    expect(check.stderr).toEqual([
      'Live check refused: unexpected argument: --dry-run (accepted: none)',
    ]);
    expect(check.calls).toEqual([]);
  });

  test('is blocked by what blocks the dry run, reported as the dry run reports it', async () => {
    const check = liveCheck({});
    const workbook = await savedDataset(
      withCourse(lifecycleDataset(), courseNames.gamma, { credits_2018: 6 }),
    );

    await expect(check.run([], { WORKBOOK_PATH: workbook })).resolves.toBe(
      exitCodes.blocked,
    );
    expect(check.stderr).toEqual([
      'Live check blocked: 1 case',
      '- [unlinked_generation_values] Предмети (Export) row 4 «Gamma Course»: 2018 name empty; 2018 credits 6',
    ]);
    expect(check.stdout).toEqual([]);
    expect(check.calls).toEqual([]);
  });

  test('fails on a workbook it cannot read and on a live file it cannot fetch', async () => {
    const missing = path.join(scratch.directory, 'missing.xlsx');
    const check = liveCheck({ 'courses.json': json([], 503) });

    await expect(check.run([], { WORKBOOK_PATH: missing })).resolves.toBe(
      exitCodes.failed,
    );
    await expect(
      check.run([], { WORKBOOK_PATH: await savedDataset() }),
    ).resolves.toBe(exitCodes.failed);
    expect(check.stderr[0]).toMatch(unreadablePattern);
    expect(check.stderr[1]).toBe('Live check failed: courses.json: HTTP 503');
    expect(check.stdout).toEqual([]);
  });

  test('compares the projection of the workbook with the live files and prints one JSON document', async () => {
    const check = liveCheck(liveAnswers(await parityLive()));
    const workbook = await savedDataset();

    await expect(check.run([], { WORKBOOK_PATH: workbook })).resolves.toBe(
      exitCodes.ok,
    );
    expect(check.stderr).toEqual([]);
    expect(check.stdout).toHaveLength(1);

    const report = output.parse(JSON.parse(check.stdout[0] ?? ''));

    expect(report.workbook).toBe(workbook);
    // The year keys are compared: the projection counts through the
    // planned pattern mappings, line by line. The committed parity counts
    // come from the rules, which tested whole histories, so two differ:
    // Theta's typed pattern spans a line break and can no longer match one
    // line, and Iota's standard mapping escapes the "." of its name, so
    // "Iota 2X0 Course-2022/2023" no longer counts.
    expect(report['courses.json']).toEqual({
      differingValues: 2,
      duplicateKeys: { live: [], projected: [] },
      keys: {
        '2021/2022': {
          differs: [
            {
              course: courseNames.theta,
              live: '2',
              projected: '0',
              year: '2021/2022',
            },
          ],
          liveOnly: [],
          projectedOnly: [],
        },
        '2022/2023': {
          differs: [
            {
              course: courseNames.iota,
              live: '1',
              projected: '0',
              year: '2022/2023',
            },
          ],
          liveOnly: [],
          projectedOnly: [],
        },
      },
      notCompared: [],
      onlyLive: [],
      onlyProjected: [],
      rows: { live: 8, matched: 8, projected: 8 },
    });

    for (const [file, rows] of [
      ['staff.json', 7],
      ['rooms.json', 3],
    ] as const) {
      expect(report[file]).toEqual({
        differingValues: 0,
        duplicateKeys: { live: 0, projected: [] },
        keys: {},
        onlyLive: 0,
        onlyProjected: [],
        rows: { live: rows, matched: rows, projected: rows },
      });
    }
  });

  test('reports the differences without a staff value or a professors text', async () => {
    const live = await parityLive();
    const [alpha, ...courses] = live['courses.json'];
    const [first, , ...staff] = live['staff.json'];
    const check = liveCheck(
      liveAnswers({
        ...live,
        'courses.json': [{ ...alpha, professors: sentinel }, ...courses],
        'staff.json': [
          { ...first, title: sentinel },
          ...staff,
          staffRow(`${sentinel} Live`),
        ],
      }),
    );

    await expect(
      check.run([], { WORKBOOK_PATH: await savedDataset() }),
    ).resolves.toBe(exitCodes.ok);

    const text = check.stdout.join('\n');
    const report = output.parse(JSON.parse(text));

    // The professors text, and the two counts of the test above.
    expect(report['courses.json']).toMatchObject({
      differingValues: 3,
      keys: {
        professors: {
          differs: ['Alpha Course'],
          liveOnly: [],
          projectedOnly: [],
        },
      },
    });
    expect(report['staff.json']).toMatchObject({
      differingValues: 1,
      keys: { title: { differs: 1, liveOnly: 0, projectedOnly: 0 } },
      onlyLive: 1,
      onlyProjected: ['Кадар (Export) row 3'],
      rows: { live: 7, matched: 6, projected: 7 },
    });
    expect(text).not.toContain(sentinel);
    expect(text).not.toContain('Synthetic Staff');
  });
});
