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

const packageScripts = z.object({ scripts: z.record(z.string(), z.string()) });
const importSummary = z.looseObject({
  conversion: z.looseObject({ status: z.string() }),
  mode: z.literal('import'),
});
const target = {
  DIRECTUS_TOKEN: 'synthetic-token',
  DIRECTUS_URL: 'http://127.0.0.1:18055',
};
const forbiddenOnStdout = ['Alpha', 'SYN-', '@', 'Synthetic', 'SENTINEL'];
const specifierPattern = /from\s+'(?<specifier>[^']+)'/gu;
const commandPattern = /^ *(?:command|entrypoint):/mu;
const dockerCommandPattern = /^(?:CMD|ENTRYPOINT)\b/mu;
const malformedPattern =
  /^Import failed: Invalid boolean "maybe" in active at row 3\. Nothing was sent to Directus\.$/u;
const jsSuffixPattern = /\.js$/u;
const interruptedPattern =
  /^Import interrupted: The import stopped while writing the workbook rows: synthetic outage\. Directus had confirmed 8 of the \d+ workbook rows, so npm run import now refuses this project: it holds a partial import\./u;
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

const savedDataset = (dataset: SyntheticDataset = lifecycleDataset()) =>
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
  const base = lifecycleDataset();
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
  test('dry-run reads the workbook without credentials and never contacts Directus', async () => {
    const run = cli();
    const workbook = await savedDataset();

    await expect(
      run.run(['--dry-run'], { WORKBOOK_PATH: workbook }),
    ).resolves.toBe(exitCodes.ok);
    expect(JSON.parse(run.stdout.join('\n'))).toMatchObject({
      courses: 8,
      moodle_users: 9,
      students: 3,
    });
    expect(run.requests.created).toBe(0);
    expect(run.stderr).toEqual([]);
  });

  test('dry-run previews the blockers an import would meet, with exit code 3 and no request', async () => {
    const run = cli();

    await expect(
      run.run(['--dry-run'], {
        WORKBOOK_PATH: await savedDataset(duplicateIndexDataset()),
      }),
    ).resolves.toBe(exitCodes.blocked);
    expect(JSON.parse(run.stdout.join('\n'))).toMatchObject({ students: 4 });
    expect(run.stderr).toEqual([
      'Dry run: the relational conversion of this workbook would be blocked by {"ambiguous_student_index":1}. npm run import would write the rows, skip the conversion and exit 3, leaving a populated project to finish with npm run migrate. Correct these ambiguous relationships in the workbook first, or plan to resolve them in Studio after the import.',
    ]);
    expect(run.requests.created).toBe(0);
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

  test('a file that is not a workbook, or a value its column cannot hold, fails the same way', async () => {
    const garbage = path.join(scratch.directory, 'not-a-workbook.xlsx');
    await writeFile(garbage, 'synthetic bytes, not a zip archive');
    const base = lifecycleDataset();
    const tooLong = await savedDataset({
      ...base,
      rooms: base.rooms.map((row, index) =>
        index === 0 ? { ...row, name: 'Room '.repeat(60) } : row,
      ),
    });
    const run = cli();

    await expect(
      run.run([], { ...target, WORKBOOK_PATH: garbage }),
    ).resolves.toBe(exitCodes.failed);
    await expect(
      run.run([], { ...target, WORKBOOK_PATH: tooLong }),
    ).resolves.toBe(exitCodes.failed);
    expect(run.stderr[0]).toContain('could not be read as an .xlsx file');
    expect(run.stderr[1]).toBe(
      'Import failed: rooms row 1 of the workbook: name holds 300 characters, but the column stores at most 255. Correct the cell before importing. Nothing was sent to Directus.',
    );
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

  test('reports a blocked conversion with exit code 3 and the finding counts only', async () => {
    const run = cli();

    await expect(
      run.run([], {
        ...target,
        WORKBOOK_PATH: await savedDataset(duplicateIndexDataset()),
      }),
    ).resolves.toBe(exitCodes.blocked);
    expect(run.stderr.join('\n')).toContain(
      'Import incomplete: the workbook rows were imported, but the relational conversion is blocked by {"ambiguous_student_index":1}.',
    );
    expect(
      importSummary.parse(JSON.parse(run.stdout.join('\n'))),
    ).toMatchObject({
      conversion: { status: 'blocked' },
    });
  });

  test('reports an import interrupted after its first write with exit code 4 and its remedy', async () => {
    const fake = fakeImportDirectus(emptyStore());
    // The staff rows follow the eight course rows.
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

    expect(importSummary.parse(JSON.parse(line))).toMatchObject({
      conversion: { status: 'converted' },
    });

    for (const forbidden of forbiddenOnStdout) {
      expect(line).not.toContain(forbidden);
    }

    expect(run.stderr).toEqual([]);
  });
});

describe('lifecycle commands', () => {
  test('name their target and workbook on the invocation; none of them, the dry run included, reads .env', () => {
    const { scripts } = packageScripts.parse(packageJson);

    expect(scripts['setup']).toBe('node --import tsx src/setup-cli.ts');
    expect(scripts['import']).toBe('node --import tsx src/cli.ts');
    expect(scripts['migrate']).toBe('node --import tsx src/migrations/cli.ts');
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

  test('the populated upgrade never loads the workbook or its reader', async () => {
    const files = new Set<string>();
    const packages = new Set<string>();
    const pending = [path.join(repositoryRoot, 'src/migrations/cli.ts')];
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      if (files.has(file)) {
        continue;
      }
      files.add(file);
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(specifierPattern)) {
        const specifier = match.groups?.['specifier'] ?? '';
        if (specifier.startsWith('.')) {
          pending.push(
            path.resolve(
              path.dirname(file),
              specifier.replace(jsSuffixPattern, '.ts'),
            ),
          );
        } else {
          packages.add(specifier);
        }
      }
    }
    const modules = [...files].map((file) =>
      path.relative(repositoryRoot, file),
    );

    expect(modules).toContain('src/migrations/converters.ts');
    expect(modules.filter((module) => module.includes('workbook'))).toEqual([]);
    expect(packages).not.toContain('exceljs');
  });
});
