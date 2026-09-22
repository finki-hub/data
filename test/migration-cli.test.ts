import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { z } from 'zod';

import packageJson from '../package.json' with { type: 'json' };
import { validateBackupReceipt } from '../src/migrations/backup-receipt.js';
import {
  loadMigrationConfig,
  MigrationConfigError,
} from '../src/migrations/config.js';
import { ledgerCollection } from '../src/migrations/ledger-claim.js';
import { writePrivateJson } from '../src/migrations/private-files.js';
import {
  migrationReportSchema,
  migrationVersion,
} from '../src/migrations/report.js';
import { runMigrationCli } from '../src/migrations/run.js';
import { sourceMapEntrySchema } from '../src/migrations/source-map.js';
import {
  makeSyntheticDataset,
  type SyntheticDataset,
} from './fixtures/synthetic-data.js';
import {
  fakeItemsDirectus,
  type FakeStore,
  storeFromDataset,
} from './migration-test-helpers.js';

const packageScripts = z.object({ scripts: z.record(z.string(), z.string()) });
const stdoutLine = z.record(z.string(), z.unknown());

const fingerprint = 'a'.repeat(64);
const otherFingerprint = 'b'.repeat(64);
const checksum = 'c'.repeat(64);
const clockValue = '2026-09-22T10:00:00.000Z';
const reportFlag = '--report';
const receiptFlag = '--backup-receipt';
const privateReport = '/private/report.json';
const targetUrl = 'http://127.0.0.1:18055';
const artifactName = 'backup.sql';
const reportName = 'report.json';
const artifactContent = 'synthetic backup';
const environment = {
  DIRECTUS_TOKEN: 'synthetic-token',
  DIRECTUS_URL: targetUrl,
};

const resumePattern = /--resume/u;
const fingerprintPattern = /fingerprint/u;
const artifactPattern = /artifact/u;
const missingArtifactPattern = /artifact .* is missing/u;
const bytesPattern = /bytes/u;
const sha256Pattern = /sha256/u;
const versionPattern = /version/u;
const urlPattern = /DIRECTUS_URL/u;
const tokenPattern = /DIRECTUS_TOKEN/u;
const modePattern = /--dry-run or --apply/u;
const reportPattern = /--report/u;
const unknownPattern = /--verbose/u;
const receiptPattern = /--backup-receipt/u;
const receiptWordsPattern = /backup receipt/u;
const driftPattern = /drift/u;
const blockerPattern = /blocker/u;
const convertersPattern = /no converters registered/u;
const notReadablePattern = /not readable/u;
const failedPattern = /^Migration failed:/u;

const clock = (): string => clockValue;

const uniqueDataset = (base = makeSyntheticDataset()): SyntheticDataset => ({
  ...base,
  course_enrollment_patterns: base.course_enrollment_patterns.filter(
    (row) => row.id !== 2,
  ),
  course_equivalencies: base.course_equivalencies.filter((row) => row.id !== 2),
  curriculum_2018: base.curriculum_2018.filter((row) => row.id !== 9),
  curriculum_2023: base.curriculum_2023.filter((row) => row.id !== 2),
  students: base.students.filter((row) => row.id !== 2),
  teaching_assignments: base.teaching_assignments.filter((row) => row.id !== 2),
});

const installedStore = (): FakeStore =>
  storeFromDataset(uniqueDataset(), { installed: true });

const ledgerRows = (store: FakeStore) =>
  store.items.get(ledgerCollection) ?? [];

const cliContext = (store: FakeStore) => {
  const fake = fakeItemsDirectus(store);
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    fake,
    io: {
      createRequest: () => fake.request,
      now: clock,
      runToken: () => 'run-token',
      stderr: (line: string) => {
        stderr.push(line);
      },
      stdout: (line: string) => {
        stdout.push(line);
      },
    },
    stderr,
    stdout,
  };
};

// A fresh private directory per test for the report, the receipt and the
// backup artifact the receipt names.
const scratch = { directory: '' };

beforeEach(async () => {
  scratch.directory = await mkdtemp(
    path.join(os.tmpdir(), 'migration-preflight-'),
  );
  await writeFile(path.join(scratch.directory, artifactName), artifactContent);
});

afterEach(async () => {
  await rm(scratch.directory, { force: true, recursive: true });
});

const receiptFor = (
  sourceFingerprint: string,
  artifactPath = artifactName,
  bytes = artifactContent.length,
) => ({
  artifacts: [
    { bytes, kind: 'database', path: artifactPath, sha256: checksum },
  ],
  createdAt: '2026-09-22T09:59:00.000Z',
  sourceFingerprint,
  version: 'backup-receipt-1',
});

const writeReceipt = async (sourceFingerprint: string): Promise<string> => {
  const receiptPath = path.join(scratch.directory, 'receipt.json');
  await writeFile(receiptPath, JSON.stringify(receiptFor(sourceFingerprint)));
  return receiptPath;
};

const readReport = async (reportPath: string) =>
  migrationReportSchema.parse(JSON.parse(await readFile(reportPath, 'utf8')));

const dryRunReport = async (
  store: FakeStore,
  reportPath: string,
): Promise<string> => {
  const context = cliContext(store);

  await expect(
    runMigrationCli(
      ['--dry-run', reportFlag, reportPath],
      environment,
      context.io,
    ),
  ).resolves.toBe(0);

  const written = await readReport(reportPath);
  return written.sourceFingerprint;
};

const modeOf = async (file: string): Promise<string> => {
  const { mode } = await stat(file);
  return mode.toString(8).slice(-3);
};

describe('backup receipt', () => {
  test('accepts a receipt whose fingerprint matches the report and whose artifact exists with the recorded size', async () => {
    const receipt = receiptFor(fingerprint);

    await expect(
      validateBackupReceipt(receipt, fingerprint, scratch.directory),
    ).resolves.toEqual({ artifacts: 1, createdAt: receipt.createdAt });
    await expect(
      validateBackupReceipt(
        receiptFor(fingerprint, path.join(scratch.directory, artifactName)),
        fingerprint,
        '/elsewhere',
      ),
    ).resolves.toMatchObject({ artifacts: 1 });
  });

  test.each([
    [receiptFor(otherFingerprint), fingerprintPattern],
    [{ ...receiptFor(fingerprint), artifacts: [] }, artifactPattern],
    [
      {
        ...receiptFor(fingerprint),
        artifacts: [{ ...receiptFor(fingerprint).artifacts[0], sha256: 'zz' }],
      },
      sha256Pattern,
    ],
    [
      { ...receiptFor(fingerprint), version: 'backup-receipt-0' },
      versionPattern,
    ],
    [receiptFor(fingerprint, 'never-taken.sql'), missingArtifactPattern],
    [receiptFor(fingerprint, artifactName, 1), bytesPattern],
  ])('refuses %j', async (candidate, pattern) => {
    await expect(
      validateBackupReceipt(candidate, fingerprint, scratch.directory),
    ).rejects.toThrow(pattern);
  });
});

describe('private files', () => {
  test('replaces a pre-existing wider-mode file and creates owner-only directories', async () => {
    const file = path.join(scratch.directory, 'nested', 'deeper', reportName);
    await writePrivateJson(file, { first: true });
    await chmod(file, 0o644);

    await writePrivateJson(file, { second: true });

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ second: true });
    await expect(modeOf(file)).resolves.toBe('600');
    await expect(modeOf(path.dirname(file))).resolves.toBe('700');
    await expect(modeOf(path.join(scratch.directory, 'nested'))).resolves.toBe(
      '700',
    );
  });
});

describe('migration cli configuration', () => {
  test('is wired as the package migrate script without an env file', () => {
    const { scripts } = packageScripts.parse(packageJson);

    expect(scripts['migrate']).toBe('node --import tsx src/migrations/cli.ts');
  });

  test('never assumes a default project', () => {
    const arguments_ = ['--dry-run', reportFlag, privateReport];

    expect(() =>
      loadMigrationConfig(arguments_, { DIRECTUS_TOKEN: 'x' }),
    ).toThrow(MigrationConfigError);
    expect(() =>
      loadMigrationConfig(arguments_, { DIRECTUS_TOKEN: 'x' }),
    ).toThrow(urlPattern);
    expect(() =>
      loadMigrationConfig(arguments_, { DIRECTUS_URL: targetUrl }),
    ).toThrow(tokenPattern);
  });

  test('requires exactly one mode and an explicit private report path', () => {
    expect(() => loadMigrationConfig([], environment)).toThrow(modePattern);
    expect(() =>
      loadMigrationConfig(
        ['--dry-run', '--apply', reportFlag, '/p'],
        environment,
      ),
    ).toThrow(modePattern);
    expect(() => loadMigrationConfig(['--dry-run'], environment)).toThrow(
      reportPattern,
    );
    expect(() =>
      loadMigrationConfig(['--dry-run', reportFlag], environment),
    ).toThrow(reportPattern);
    expect(() =>
      loadMigrationConfig(
        ['--dry-run', reportFlag, '/p', '--verbose'],
        environment,
      ),
    ).toThrow(unknownPattern);
    expect(
      loadMigrationConfig(
        ['--dry-run', reportFlag, privateReport],
        environment,
      ),
    ).toEqual({
      backupReceipt: null,
      directus: { token: 'synthetic-token', url: new URL(targetUrl) },
      mode: 'dry-run',
      report: path.resolve(privateReport),
      resume: false,
    });
  });

  test('refuses --apply without a backup receipt and accepts --resume only with --apply', () => {
    expect(() =>
      loadMigrationConfig(['--apply', reportFlag, '/p'], environment),
    ).toThrow(receiptPattern);
    expect(() =>
      loadMigrationConfig(
        ['--dry-run', reportFlag, '/p', '--resume'],
        environment,
      ),
    ).toThrow(resumePattern);
    expect(
      loadMigrationConfig(
        ['--apply', reportFlag, '/p', receiptFlag, '/r', '--resume'],
        { DIRECTUS_ADMIN_TOKEN: 'admin', DIRECTUS_URL: targetUrl },
      ),
    ).toEqual({
      backupReceipt: path.resolve('/r'),
      directus: { token: 'admin', url: new URL(targetUrl) },
      mode: 'apply',
      report: path.resolve('/p'),
      resume: true,
    });
  });
});

describe('migration cli dry-run', () => {
  test('dry-run writes the private report and prints aggregate counts only, without a mutation', async () => {
    const reportPath = path.join(scratch.directory, reportName);
    const context = cliContext(
      storeFromDataset(makeSyntheticDataset(), { installed: true }),
    );

    const code = await runMigrationCli(
      ['--dry-run', reportFlag, reportPath],
      environment,
      context.io,
    );

    expect(code).toBe(0);
    expect(context.fake.mutations()).toEqual([]);
    expect(context.stderr).toEqual([]);
    expect(context.stdout).toHaveLength(1);

    const printed = context.stdout[0] ?? '';
    const summary = stdoutLine.parse(JSON.parse(printed));

    expect(summary).toMatchObject({
      blockers: 4,
      ledger: { completed: [], failed: [], running: [] },
      migratable: false,
      mode: 'dry-run',
      version: migrationVersion,
    });
    expect(summary['findings']).toMatchObject({
      ambiguous_curriculum_2023: 1,
      duplicate_student_index: 1,
    });
    expect(summary['counts']).toMatchObject({
      collections: { courses: 8, students: 4 },
      flows: 0,
    });
    expect(printed).not.toContain('Alpha');
    expect(printed).not.toContain('SYN-');
    expect(printed).not.toContain('@');
    expect(printed).not.toContain(reportPath);

    const written = await readReport(reportPath);

    expect(written.blockers).toHaveLength(4);
    await expect(modeOf(reportPath)).resolves.toBe('600');
  });
});

describe('migration cli apply refusals', () => {
  test('apply refuses a report with blockers, a missing receipt, a drifted receipt and drifted sources, mutating nothing', async () => {
    const reportPath = path.join(scratch.directory, reportName);
    const sourceFingerprint = await dryRunReport(installedStore(), reportPath);

    const missing = cliContext(installedStore());

    await expect(
      runMigrationCli(
        [
          '--apply',
          reportFlag,
          reportPath,
          receiptFlag,
          path.join(scratch.directory, 'nope.json'),
        ],
        environment,
        missing.io,
      ),
    ).resolves.toBe(1);
    expect(missing.stderr.join('\n')).toMatch(receiptWordsPattern);
    expect(missing.fake.mutations()).toEqual([]);

    const drifted = cliContext(installedStore());

    await expect(
      runMigrationCli(
        [
          '--apply',
          reportFlag,
          reportPath,
          receiptFlag,
          await writeReceipt(otherFingerprint),
        ],
        environment,
        drifted.io,
      ),
    ).resolves.toBe(1);
    expect(drifted.stderr.join('\n')).toMatch(fingerprintPattern);
    expect(drifted.fake.mutations()).toEqual([]);

    const changed = installedStore();
    changed.items
      .get('courses')
      ?.push({ ...uniqueDataset().courses[0], id: 77, name: 'Late Course' });
    const drift = cliContext(changed);

    await expect(
      runMigrationCli(
        [
          '--apply',
          reportFlag,
          reportPath,
          receiptFlag,
          await writeReceipt(sourceFingerprint),
        ],
        environment,
        drift.io,
      ),
    ).resolves.toBe(1);
    expect(drift.stderr.join('\n')).toMatch(driftPattern);
    expect(drift.fake.mutations()).toEqual([]);

    const blockedPath = path.join(scratch.directory, 'blocked.json');
    const blockedFingerprint = await dryRunReport(
      storeFromDataset(makeSyntheticDataset(), { installed: true }),
      blockedPath,
    );
    const applyBlocked = cliContext(
      storeFromDataset(makeSyntheticDataset(), { installed: true }),
    );

    await expect(
      runMigrationCli(
        [
          '--apply',
          reportFlag,
          blockedPath,
          receiptFlag,
          await writeReceipt(blockedFingerprint),
        ],
        environment,
        applyBlocked.io,
      ),
    ).resolves.toBe(1);
    expect(applyBlocked.stderr.join('\n')).toMatch(blockerPattern);
    expect(applyBlocked.fake.mutations()).toEqual([]);
  });

  test('apply refuses a receipt whose backup artifact is gone or changed, mutating nothing', async () => {
    const reportPath = path.join(scratch.directory, reportName);
    const sourceFingerprint = await dryRunReport(installedStore(), reportPath);
    const receiptPath = await writeReceipt(sourceFingerprint);
    await writeFile(path.join(scratch.directory, artifactName), 'truncated');
    const changed = cliContext(installedStore());

    await expect(
      runMigrationCli(
        ['--apply', reportFlag, reportPath, receiptFlag, receiptPath],
        environment,
        changed.io,
      ),
    ).resolves.toBe(1);
    expect(changed.stderr.join('\n')).toMatch(bytesPattern);
    expect(changed.fake.mutations()).toEqual([]);

    await rm(path.join(scratch.directory, artifactName));
    const gone = cliContext(installedStore());

    await expect(
      runMigrationCli(
        ['--apply', reportFlag, reportPath, receiptFlag, receiptPath],
        environment,
        gone.io,
      ),
    ).resolves.toBe(1);
    expect(gone.stderr.join('\n')).toMatch(missingArtifactPattern);
    expect(gone.fake.mutations()).toEqual([]);
  });

  test('apply refuses while the relational target collections are not readable, and fails closed when their rows are not', async () => {
    const reportPath = path.join(scratch.directory, reportName);
    const sourceFingerprint = await dryRunReport(installedStore(), reportPath);
    const receiptPath = await writeReceipt(sourceFingerprint);
    const applyArguments = [
      '--apply',
      reportFlag,
      reportPath,
      receiptFlag,
      receiptPath,
    ];
    const absent = cliContext(
      storeFromDataset(uniqueDataset(), { installed: false }),
    );

    await expect(
      runMigrationCli(applyArguments, environment, absent.io),
    ).resolves.toBe(1);
    expect(absent.stderr.join('\n')).toMatch(notReadablePattern);
    expect(absent.fake.mutations()).toEqual([]);

    const unreadable = installedStore();
    unreadable.items
      .get('curriculum_entries')
      ?.push({ generation: '2023', id: 1, name: 'Hand made' });
    const broken = cliContext(unreadable);

    await expect(
      runMigrationCli(applyArguments, environment, broken.io),
    ).resolves.toBe(1);
    expect(broken.stderr.join('\n')).toMatch(failedPattern);
    expect(broken.stderr.join('\n')).toContain('source_collection');
    expect(broken.fake.mutations()).toEqual([]);
    expect(ledgerRows(unreadable)).toEqual([]);
  });
});

describe('migration cli apply', () => {
  test('apply records the preflight step in the ledger, reports zero converters and writes no target row', async () => {
    const reportPath = path.join(scratch.directory, reportName);
    const store = installedStore();
    const sourceFingerprint = await dryRunReport(store, reportPath);
    const receiptPath = await writeReceipt(sourceFingerprint);
    const applyArguments = [
      '--apply',
      reportFlag,
      reportPath,
      receiptFlag,
      receiptPath,
    ];

    const apply = cliContext(store);
    const code = await runMigrationCli(applyArguments, environment, apply.io);

    expect(code).toBe(0);
    expect(apply.stderr).toEqual([]);

    const summary = stdoutLine.parse(JSON.parse(apply.stdout[0] ?? ''));

    expect(summary).toMatchObject({
      backup: { artifacts: 1 },
      converters: 0,
      mode: 'apply',
      sourceFingerprint,
      steps: { completed: ['preflight'], skipped: [] },
      version: migrationVersion,
    });
    expect(String(summary['message'])).toMatch(convertersPattern);
    expect(apply.fake.mutations().map(({ pathname }) => pathname)).toEqual([
      `/items/${ledgerCollection}`,
      `/items/${ledgerCollection}?fields=id`,
    ]);

    for (const collection of [
      'curriculum_entries',
      'course_curricula',
      'course_enrollment_rules',
      'academic_years',
    ]) {
      expect(store.items.get(collection)).toEqual([]);
    }

    expect(ledgerRows(store)[0]).toMatchObject({
      source_fingerprint: sourceFingerprint,
      status: 'completed',
      step: 'preflight',
    });

    const idMap = z
      .array(sourceMapEntrySchema)
      .parse(ledgerRows(store)[0]?.['id_map']);

    expect(idMap.length).toBeGreaterThan(0);
    expect(idMap.every(({ targetId }) => targetId !== null)).toBeTruthy();
    expect(idMap.filter(({ status }) => status === 'existing')).toEqual([]);
    expect(
      idMap.find(
        ({ sourceCollection, sourceId }) =>
          sourceCollection === 'student_council' && sourceId === 3,
      ),
    ).toMatchObject({ targetCollection: 'students', targetId: 3 });

    const again = cliContext(store);

    await expect(
      runMigrationCli(applyArguments, environment, again.io),
    ).resolves.toBe(0);
    expect(again.fake.mutations()).toEqual([]);
    expect(stdoutLine.parse(JSON.parse(again.stdout[0] ?? ''))).toMatchObject({
      steps: { completed: [], skipped: ['preflight'] },
    });
    expect(ledgerRows(store)).toHaveLength(1);
  });
});
