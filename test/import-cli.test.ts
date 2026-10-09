import type ExcelJS from 'exceljs';

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { z } from 'zod';

import packageJson from '../package.json' with { type: 'json' };
import { runImportCli } from '../src/import-run.js';
import { exitCodes } from '../src/lifecycle.js';
import {
  courseNames,
  type SyntheticDataset,
} from './fixtures/synthetic-data.js';
import {
  lifecycleDataset,
  syntheticWorkbook,
  withoutColumn,
} from './fixtures/synthetic-workbook.js';
import { withCourse } from './import-plan-helpers.js';
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
  fixes: z.record(z.string(), z.array(z.string())),
  mode: z.enum(['dry-run', 'import']),
  rows: counts,
  skipped: counts,
  unstorable: counts,
  warnings: counts,
});
const importSummary = checkSummary.extend({
  bookmarks: z.array(z.string()),
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
  /^Import failed: Кадар \(Export\) row 3, column "active": invalid boolean "maybe"$/u;
const unreadablePattern =
  /^Import failed: workbook \/.+\/not-a-workbook\.xlsx: not readable as \.xlsx \(Can't find end of central directory : is this a zip file \? .+\)$/u;
const interruptedPattern =
  /^Import interrupted: synthetic outage \(rows confirmed: \d+\/\d+\)$/u;
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

const postedCourse = z.array(
  z.object({ pattern_mappings: z.array(z.unknown()) }),
);

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

// The lifecycle dataset with 2018 credits for Gamma, which has no 2018
// name: a value no relational row could hold, so the import refuses it.
const creditsWithoutName = (): SyntheticDataset =>
  withCourse(lifecycleDataset(), courseNames.gamma, { credits_2018: 6 });

const creditsRefusal =
  '- [unlinked_generation_values] Предмети (Export) row 4 «Gamma Course»: 2018 name empty; 2018 credits 6';

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
        superseded_assignment: 2,
      },
    });
    expect(summary.warnings).toMatchObject({ unmatched_council_index: 1 });
    expect([summary.blockers, summary.fixes, summary.unstorable]).toEqual([
      {},
      {
        repeated_staff_name: [
          'Наставен Кадар row 8, column "Професори", line 3',
        ],
      },
      {},
    ]);
    expect(run.requests.created).toBe(0);
    expect(run.stderr).toEqual([]);
  });

  test('dry-run accepts a second teaching row of a course, ignoring it with a warning placed under fixes', async () => {
    const run = cli();

    await expect(
      run.run(['--dry-run'], {
        WORKBOOK_PATH: await savedDataset(lifecycleDataset()),
      }),
    ).resolves.toBe(exitCodes.ok);

    const line = run.stdout.join('\n');
    const summary = checkSummary.parse(JSON.parse(line));

    expect(summary.blockers).toEqual({});
    expect(summary.warnings).toMatchObject({ duplicate_assignment: 1 });
    expect(summary.fixes).toEqual({
      duplicate_assignment: ['Наставен Кадар row 3 (used: row 2)'],
      repeated_staff_name: ['Наставен Кадар row 9, column "Професори", line 3'],
    });
    expect(
      Object.keys(z.record(z.string(), z.unknown()).parse(JSON.parse(line))),
    ).toEqual([
      'mode',
      'blockers',
      'fixes',
      'rows',
      'skipped',
      'unstorable',
      'warnings',
    ]);

    for (const forbidden of forbiddenOnStdout) {
      expect(line).not.toContain(forbidden);
    }

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
    expect(run.stderr).toEqual([
      'Import refused: DIRECTUS_URL not set (.env not read)',
    ]);
    await expect(
      run.run(['--apply'], { ...target, WORKBOOK_PATH: workbook }),
    ).resolves.toBe(exitCodes.refused);
    expect(run.stderr.at(-1)).toBe(
      'Import refused: unexpected argument: --apply (accepted: --dry-run)',
    );
    await expect(
      run.run(['--dry-run', '--dry-run'], { WORKBOOK_PATH: workbook }),
    ).resolves.toBe(exitCodes.refused);
    expect(run.stderr.at(-1)).toBe(
      'Import refused: duplicate argument: --dry-run',
    );
    await expect(
      run.run(['--dry-run', '--x', '--dry-run', '--x'], {
        WORKBOOK_PATH: workbook,
      }),
    ).resolves.toBe(exitCodes.refused);
    expect(run.stderr.at(-1)).toBe(
      'Import refused: unexpected argument: --x (accepted: --dry-run); duplicate argument: --dry-run',
    );
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
    expect(run.stderr[0]).toMatch(unreadablePattern);
    await expect(
      run.run(['--dry-run'], { WORKBOOK_PATH: garbage }),
    ).resolves.toBe(exitCodes.failed);
    expect(run.stderr).toHaveLength(2);
    expect(run.stderr[1]).toMatch(unreadablePattern);
    expect(run.requests.created).toBe(0);
  });

  test('refuses a populated project with exit code 2 and no write', async () => {
    const store = emptyStore();
    store.items.set('courses', [{ id: 1, name: 'Existing Course' }]);
    const run = cli(fakeImportDirectus(store));

    await expect(
      run.run([], { ...target, WORKBOOK_PATH: await savedDataset() }),
    ).resolves.toBe(exitCodes.refused);
    expect(run.stderr).toEqual([
      'Import refused: project not empty: 1 record in 1 collection (courses 1)',
    ]);
    expect(run.fake.mutations()).toEqual([]);
    expect(run.stdout).toEqual([]);
  });

  test('reports an import interrupted after its first write with exit code 4 and the rows confirmed', async () => {
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
      rows: { course_curricula: 12, courses: 8, moodle_pattern_mappings: 10 },
    });
    expect([summary.blockers, summary.unstorable]).toEqual([{}, {}]);

    for (const forbidden of forbiddenOnStdout) {
      expect(line).not.toContain(forbidden);
    }

    expect(run.stderr).toEqual([]);
  });
});

describe('workbooks the import refuses', () => {
  test('dry-run names every case an import would refuse, by code, sheet, row and course, with exit code 3 and no request', async () => {
    const run = cli();

    await expect(
      run.run(['--dry-run'], {
        WORKBOOK_PATH: await savedDataset(creditsWithoutName()),
      }),
    ).resolves.toBe(exitCodes.blocked);
    expect(checkSummary.parse(JSON.parse(run.stdout.join('\n')))).toMatchObject(
      {
        blockers: { unlinked_generation_values: 1 },
        fixes: { duplicate_assignment: ['Наставен Кадар row 3 (used: row 2)'] },
      },
    );
    expect(run.stderr).toEqual([
      'Import dry run blocked: 1 case',
      creditsRefusal,
    ]);
    expect(run.requests.created).toBe(0);
  });

  test('names every value no column can hold with every blocking case in one run, with exit code 3 and no request', async () => {
    const base = creditsWithoutName();
    const tooLong = await savedDataset({
      ...base,
      rooms: base.rooms.map((row, index) =>
        index === 0 ? { ...row, name: 'Room '.repeat(60) } : row,
      ),
    });
    const refusals = [
      '- [unstorable] Простории (Export) row 2, rooms.name: 300 characters, max 255',
      creditsRefusal,
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
      blockers: { unlinked_generation_values: 1 },
      mode: 'dry-run',
      unstorable: { 'rooms.name': 1 },
    });
    expect(dryRun.stderr).toEqual([
      'Import dry run blocked: 2 cases',
      ...refusals,
    ]);
    expect(run.stderr).toEqual(['Import blocked: 2 cases', ...refusals]);
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
      'Import blocked: 1 case',
      '- [ambiguous_student_index] ФСС row 2: index matches several students: Индекси - Година row 3, Индекси - Други row 4',
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

describe('the Еквиваленции generation columns', () => {
  test('dry-run reads an Еквиваленции sheet without the label-only 2013 column, and fails without a curriculum generation column', async () => {
    const savedWithout = (header: string) =>
      saved(
        withoutColumn(syntheticWorkbook(lifecycleDataset()), {
          header,
          sheet: 'Еквиваленции',
        }),
        `without ${header}.xlsx`,
      );
    const run = cli();

    await expect(
      run.run(['--dry-run'], {
        WORKBOOK_PATH: await savedDataset(lifecycleDataset()),
      }),
    ).resolves.toBe(exitCodes.ok);

    const full = checkSummary.parse(JSON.parse(run.stdout.join('\n')));
    run.stdout.length = 0;

    await expect(
      run.run(['--dry-run'], {
        WORKBOOK_PATH: await savedWithout('Предмет (2013)'),
      }),
    ).resolves.toBe(exitCodes.ok);

    const summary = checkSummary.parse(JSON.parse(run.stdout.join('\n')));
    // Every 2013 label goes, and with it the one row that held only a 2013
    // label.
    const labels2013 = lifecycleDataset().course_equivalencies.filter(
      (row) => row['course_2013'] !== null,
    ).length;

    expect(summary.blockers).toEqual({});
    expect(summary.rows).toEqual({
      ...full.rows,
      course_equivalencies: (full.rows['course_equivalencies'] ?? 0) - 1,
      course_equivalency_members:
        (full.rows['course_equivalency_members'] ?? 0) - labels2013,
    });
    expect(run.stderr).toEqual([]);
    await expect(
      run.run(['--dry-run'], {
        WORKBOOK_PATH: await savedWithout('Предмет (2018)'),
      }),
    ).resolves.toBe(exitCodes.failed);
    expect(run.stderr).toEqual([
      'Import failed: Еквиваленции row 1: missing column "Предмет (2018)"',
    ]);
    expect(run.requests.created).toBe(0);
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

describe('the courses the import writes', () => {
  test('are posted with an empty list of pattern mappings, so Directus adds no default one: the import writes them itself', async () => {
    const run = cli();

    await expect(
      run.run([], { ...target, WORKBOOK_PATH: await savedDataset() }),
    ).resolves.toBe(exitCodes.ok);

    const postedCourses = run.fake.calls
      .filter(
        ({ method, pathname }) =>
          method === 'POST' && pathname.startsWith('/items/courses?'),
      )
      .flatMap(({ body }) => postedCourse.parse(body));

    expect(postedCourses).toHaveLength(8);
    expect(
      postedCourses.filter(
        ({ pattern_mappings }) => pattern_mappings.length > 0,
      ),
    ).toEqual([]);
    expect(run.fake.store.items.get('moodle_pattern_mappings')).toHaveLength(
      10,
    );
  });
});
