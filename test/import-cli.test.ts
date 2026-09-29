import type ExcelJS from 'exceljs';

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { SyntheticDataset } from './fixtures/synthetic-data.js';

import packageJson from '../package.json' with { type: 'json' };
import { runImportCli } from '../src/import-run.js';
import { exitCodes } from '../src/lifecycle.js';
import {
  lifecycleDataset,
  syntheticWorkbook,
} from './fixtures/synthetic-workbook.js';
import {
  emptyStore,
  fakeImportDirectus,
  type ImportFake,
} from './import-test-helpers.js';
import { parityDataset } from './relational-export-helpers.js';

const packageScripts = z.object({ scripts: z.record(z.string(), z.string()) });
const counts = z.record(z.string(), z.number().int());
const checkSummary = z.strictObject({
  blockers: counts,
  mode: z.enum(['dry-run', 'import']),
  rows: counts,
  skipped: counts,
  unstorable: counts,
  warnings: counts,
});
const importSummary = checkSummary.extend({
  mode: z.literal('import'),
  setup: z.record(z.string(), z.unknown()),
});
const target = {
  DIRECTUS_TOKEN: 'synthetic-token',
  DIRECTUS_URL: 'http://127.0.0.1:18055',
};
const forbiddenOnStdout = ['Alpha', 'SYN-', '@', 'Synthetic', 'SENTINEL'];
const commandPattern = /^ *(?:command|entrypoint):/mu;
const dockerCommandPattern = /^(?:CMD|ENTRYPOINT)\b/mu;
const malformedPattern =
  /^Import failed: Invalid boolean "maybe" in active at row 3\. Nothing was sent to Directus\.$/u;
const interruptedPattern =
  /^Import interrupted: The import stopped while writing the relational rows: synthetic outage\. Directus had confirmed \d+ of the \d+ planned rows\. Set up a fresh project and import again\.$/u;
const repositoryRoot = path.resolve(import.meta.dirname, '..');

const scratch = { directory: '' };

beforeEach(async () => {
  scratch.directory = await mkdtemp(path.join(os.tmpdir(), 'import-cli-'));
});

afterEach(async () => {
  await rm(scratch.directory, { force: true, recursive: true });
});

const saved = async (
  workbook: ExcelJS.Workbook,
  name = 'synthetic.xlsx',
): Promise<string> => {
  const file = path.join(scratch.directory, name);
  await workbook.xlsx.writeFile(file);
  return file;
};

const savedDataset = (dataset: SyntheticDataset = parityDataset()) =>
  saved(syntheticWorkbook(dataset));

// The CLI over a fake Directus; `requests` counts every request the CLI
// created, so a test proves when it never contacted Directus at all.
const cli = (fake: ImportFake = fakeImportDirectus(emptyStore())) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests = { created: 0 };
  return {
    fake,
    requests,
    run: (
      arguments_: readonly string[],
      environment: Readonly<Record<string, string | undefined>>,
    ) =>
      runImportCli(arguments_, environment, {
        ...fake.io,
        createRequest: () => {
          requests.created += 1;
          return fake.request;
        },
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

const duplicateIndexDataset = (): SyntheticDataset => {
  const base = parityDataset();
  return {
    ...base,
    students: [
      ...base.students,
      {
        id: 99,
        index_number: 'SYN-0001',
        name: 'Synthetic Student One (Other List)',
        source_group: 'SENTINEL_PRIVATE_SOURCE_GROUP:other-list',
      },
    ],
  };
};

describe('import command', () => {
  test('dry-run reads the workbook without credentials, never contacts Directus and prints counts only', async () => {
    const run = cli();
    const workbook = await savedDataset();

    await expect(
      run.run(['--dry-run'], { WORKBOOK_PATH: workbook }),
    ).resolves.toBe(exitCodes.ok);

    const summary = checkSummary.parse(JSON.parse(run.stdout.join('\n')));

    expect(summary).toMatchObject({
      blockers: {},
      mode: 'dry-run',
      rows: { courses: 8, moodle_users: 9, students: 3 },
      skipped: {
        duplicate_pattern: 1,
        orphan_assignment: 1,
        orphan_pattern: 1,
      },
    });
    expect(summary.warnings).toMatchObject({ unmatched_council_index: 1 });
    expect([summary.blockers, summary.unstorable]).toEqual([{}, {}]);
    expect(run.requests.created).toBe(0);
    expect(run.stderr).toEqual([]);
  });

  test('refuses to import without an explicit target', async () => {
    const run = cli();
    const workbook = await savedDataset();

    await expect(
      run.run([], {
        DIRECTUS_TOKEN: 'synthetic-token',
        WORKBOOK_PATH: workbook,
      }),
    ).resolves.toBe(exitCodes.refused);
    expect(run.stderr.join('\n')).toContain(
      'Import refused: DIRECTUS_URL is not set. The import never assumes a default project and does not read .env',
    );
    await expect(
      run.run(['--apply'], { ...target, WORKBOOK_PATH: workbook }),
    ).resolves.toBe(exitCodes.refused);
    expect(run.stderr.at(-1)).toContain('takes no argument except --dry-run');
    expect(run.requests.created).toBe(0);
  });

  test('a malformed workbook fails before Directus is contacted', async () => {
    const base = lifecycleDataset();
    const malformed = await savedDataset({
      ...base,
      staff: base.staff.map((row, index) =>
        index === 1 ? { ...row, active: 'maybe' } : row,
      ),
    });
    const run = cli();

    await expect(
      run.run([], { ...target, WORKBOOK_PATH: malformed }),
    ).resolves.toBe(exitCodes.failed);
    expect(run.stderr.join('\n')).toMatch(malformedPattern);
    expect(run.requests.created).toBe(0);
    expect(run.fake.calls).toEqual([]);
  });

  test('a file that is not a workbook fails the same way', async () => {
    const garbage = path.join(scratch.directory, 'not-a-workbook.xlsx');
    await writeFile(garbage, 'synthetic bytes, not a zip archive');
    const run = cli();

    await expect(
      run.run([], { ...target, WORKBOOK_PATH: garbage }),
    ).resolves.toBe(exitCodes.failed);
    expect(run.stderr).toHaveLength(1);
    expect(run.stderr[0]).toContain('could not be read as an .xlsx file');
    expect(run.requests.created).toBe(0);
  });

  test('refuses a populated project with exit code 2 and no write', async () => {
    const store = emptyStore();
    store.items.set('courses', [{ id: 1, name: 'Existing Course' }]);
    const run = cli(fakeImportDirectus(store));

    await expect(
      run.run([], { ...target, WORKBOOK_PATH: await savedDataset() }),
    ).resolves.toBe(exitCodes.refused);
    expect(run.stderr.join('\n')).toContain(
      'Import refused: The project already holds 1 record(s) in 1 application collection(s): courses 1.',
    );
    expect(run.fake.mutations()).toEqual([]);
    expect(run.stdout).toEqual([]);
  });

  test('reports an import interrupted after its first write with exit code 4 and its remedy', async () => {
    const fake = fakeImportDirectus(emptyStore());
    // The staff rows follow the academic years, generations and programs.
    const failing: ImportFake['request'] = (pathname, init) =>
      init?.method === 'POST' && pathname.startsWith('/items/staff')
        ? Promise.reject(new Error('synthetic outage'))
        : fake.request(pathname, init);
    const run = cli({ ...fake, request: failing });

    await expect(
      run.run([], { ...target, WORKBOOK_PATH: await savedDataset() }),
    ).resolves.toBe(exitCodes.interrupted);
    expect(run.stderr).toHaveLength(1);
    expect(run.stderr[0]).toMatch(interruptedPattern);
    expect(run.stdout).toEqual([]);
  });

  test('imports an empty project with exit code 0 and prints aggregate counts only', async () => {
    const run = cli();

    await expect(
      run.run([], { ...target, WORKBOOK_PATH: await savedDataset() }),
    ).resolves.toBe(exitCodes.ok);

    const line = run.stdout.join('\n');

    const summary = importSummary.parse(JSON.parse(line));

    expect(summary).toMatchObject({
      rows: { course_curricula: 12, courses: 8 },
    });
    expect([summary.blockers, summary.unstorable]).toEqual([{}, {}]);

    for (const forbidden of forbiddenOnStdout) {
      expect(line).not.toContain(forbidden);
    }

    expect(run.stderr).toEqual([]);
  });
});

describe('workbooks the import refuses', () => {
  test('dry-run explains every case an import would refuse, by course, sheet and row, with exit code 3 and no request', async () => {
    const run = cli();

    await expect(
      run.run(['--dry-run'], {
        WORKBOOK_PATH: await savedDataset(lifecycleDataset()),
      }),
    ).resolves.toBe(exitCodes.blocked);
    expect(
      checkSummary.parse(JSON.parse(run.stdout.join('\n'))).blockers,
    ).toEqual({ duplicate_assignment: 1 });
    expect(run.stderr).toEqual([
      'Dry run: npm run import would refuse this workbook: correct these 1 case(s) in the workbook, then import again; nothing was sent to Directus.',
      '- [duplicate_assignment] «Alpha Course» (Предмети (Export) row 2): Наставен Кадар rows 2 and 3 both name it; keep one teaching row per course.',
    ]);
    expect(run.requests.created).toBe(0);
  });

  test('names every value no column can hold with every blocking case in one run, with exit code 3 and no request', async () => {
    const base = lifecycleDataset();
    const tooLong = await savedDataset({
      ...base,
      rooms: base.rooms.map((row, index) =>
        index === 0 ? { ...row, name: 'Room '.repeat(60) } : row,
      ),
    });
    const refusals = [
      '- Простории (Export) row 2: rooms.name holds 300 characters, but the column stores at most 255',
      '- [duplicate_assignment] «Alpha Course» (Предмети (Export) row 2): Наставен Кадар rows 2 and 3 both name it; keep one teaching row per course.',
    ];
    const dryRun = cli();
    const run = cli();

    await expect(
      dryRun.run(['--dry-run'], { WORKBOOK_PATH: tooLong }),
    ).resolves.toBe(exitCodes.blocked);
    await expect(
      run.run([], { ...target, WORKBOOK_PATH: tooLong }),
    ).resolves.toBe(exitCodes.blocked);
    expect(
      checkSummary.parse(JSON.parse(dryRun.stdout.join('\n'))),
    ).toMatchObject({
      blockers: { duplicate_assignment: 1 },
      mode: 'dry-run',
      unstorable: { 'rooms.name': 1 },
    });
    expect(dryRun.stderr).toEqual([
      'Dry run: npm run import would refuse this workbook: correct these 2 case(s) in the workbook, then import again; nothing was sent to Directus.',
      ...refusals,
    ]);
    expect(run.stderr).toEqual([
      'Import blocked: correct these 2 case(s) in the workbook, then import again; nothing was sent to Directus.',
      ...refusals,
    ]);
    expect(
      checkSummary.parse(JSON.parse(run.stdout.join('\n'))).unstorable,
    ).toEqual({ 'rooms.name': 1 });
    expect([...dryRun.stdout, ...dryRun.stderr].join('\n')).not.toContain(
      'Room ',
    );
    expect(dryRun.requests.created + run.requests.created).toBe(0);
  });

  test('refuses a blocked workbook before Directus is contacted, with exit code 3 and counts only', async () => {
    const run = cli();

    await expect(
      run.run([], {
        ...target,
        WORKBOOK_PATH: await savedDataset(duplicateIndexDataset()),
      }),
    ).resolves.toBe(exitCodes.blocked);
    expect(run.stderr).toEqual([
      'Import blocked: correct these 1 case(s) in the workbook, then import again; nothing was sent to Directus.',
      '- [ambiguous_student_index] ФСС row 2: several students carry its index (Индекси - Година row 3, Индекси - Други row 4); correct the index, or keep one student row for it.',
    ]);
    expect(checkSummary.parse(JSON.parse(run.stdout.join('\n')))).toMatchObject(
      {
        blockers: { ambiguous_student_index: 1 },
        mode: 'import',
      },
    );
    expect(run.requests.created).toBe(0);
    expect(run.fake.calls).toEqual([]);
  });
});

describe('lifecycle commands', () => {
  test('name their target and workbook on the invocation; none of them, the dry run included, reads .env', () => {
    const { scripts } = packageScripts.parse(packageJson);

    expect(scripts['setup']).toBe('node --import tsx src/setup-cli.ts');
    expect(scripts['import']).toBe('node --import tsx src/cli.ts');
    expect(scripts).not.toHaveProperty('migrate');
    expect(scripts['import:dry-run']).toBe(
      'node --import tsx src/cli.ts --dry-run',
    );
  });

  test('a normal restart runs none of them', async () => {
    const { scripts } = packageScripts.parse(packageJson);
    const compose = await readFile(
      path.join(repositoryRoot, 'compose.yaml'),
      'utf8',
    );
    const dockerfile = await readFile(
      path.join(repositoryRoot, 'directus/Dockerfile'),
      'utf8',
    );

    for (const hook of [
      'install',
      'postinstall',
      'poststart',
      'preinstall',
      'prepare',
      'prestart',
      'start',
    ]) {
      expect(Object.keys(scripts)).not.toContain(hook);
    }

    expect(compose).not.toMatch(commandPattern);
    expect(dockerfile).not.toMatch(dockerCommandPattern);
    expect(dockerfile).not.toContain('npm');
  });
});
