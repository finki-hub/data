import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  applySchemaConstraints,
  applySourceInvalidation,
} from '../../src/data-model/constraints.js';
import { installDataModel } from '../../src/data-model/install.js';
import { createDirectusRequest } from '../../src/directus-request.js';
import { fingerprintInventory } from '../../src/migrations/fingerprint.js';
import { readInventory } from '../../src/migrations/inventory.js';
import {
  fencedPatch,
  ledgerCollection,
} from '../../src/migrations/ledger-claim.js';
import { migrationReportSchema } from '../../src/migrations/report.js';
import { runMigrationCli } from '../../src/migrations/run.js';
import { collectionKeys } from '../../src/schema.js';
import { makeSyntheticDataset } from '../fixtures/synthetic-data.js';
import { targetFrom } from '../isolated-target.mjs';
import {
  adminRequest,
  json,
  read,
  request,
  withDataModel,
} from './data-model-helpers.mjs';

const targetCollections = [
  'academic_years',
  'course_curricula',
  'course_enrollment_rules',
  'curriculum_entries',
  'curriculum_generations',
  'study_programs',
  'curriculum_entry_program_states',
  'course_equivalency_members',
];
const backupReceiptVersion = 'backup-receipt-1';
const clockValue = '2026-09-22T12:00:00.000Z';
const artifactName = 'synthetic-backup.sql';
const artifactContent = 'synthetic backup';
const receiptPattern = /backup receipt/u;
const resumePattern = /--resume/u;
const missingArtifactPattern = /artifact .* is missing/u;
const driftPattern = /drift/u;
const blockerPattern = /blocker/u;
const fingerprintPattern = /fingerprint/u;
const convertersPattern = /5 converter step\(s\) ran under the ledger/u;
const stepNames = [
  'curricula',
  'rules',
  'assignments',
  'council',
  'equivalencies',
];
// What the converter steps write for the seeded dataset: the three
// workbook generations with the 15 programs of the curriculum sheets,
// every curriculum row with one state row per nonempty program cell, one
// link per unique current/legacy label, the fifteen years with a rule per
// course and year, one role row per resolved or retained text and one
// equivalency member per filled label.
const migratedCounts = {
  academic_years: 15,
  course_curricula: 12,
  course_enrollment_rules: 8 * 15,
  course_equivalency_members: 21,
  curriculum_entries: 18,
  curriculum_entry_program_states: 33,
  curriculum_generations: 3,
  study_programs: 15,
  teaching_assignments: 7 + 10,
};

const applyWith = (report, receipt) => [
  '--apply',
  '--report',
  report,
  '--backup-receipt',
  receipt,
];

// The synthetic dataset without its deliberate duplicates except the
// repeated student index, which the first dry-run must report as a blocker.
const seedDataset = () => {
  const base = makeSyntheticDataset();
  return {
    ...base,
    course_enrollment_patterns: base.course_enrollment_patterns.filter(
      (row) => row.id !== 2,
    ),
    course_equivalencies: base.course_equivalencies.filter(
      (row) => row.id !== 2,
    ),
    curriculum_2018: base.curriculum_2018.filter((row) => row.id !== 9),
    curriculum_2023: base.curriculum_2023.filter((row) => row.id !== 2),
    teaching_assignments: base.teaching_assignments.filter(
      (row) => row.id !== 2,
    ),
  };
};

const get = async (target, pathname) => {
  const body = await read(
    await request(target, pathname, { token: target.token }),
    200,
  );
  return body.data;
};

const count = async (target, collection) => {
  const rows = await get(target, `/items/${collection}?aggregate[count]=*`);
  return Number(rows[0].count);
};

const counts = async (target) => {
  const result = {};
  for (const collection of [
    ...collectionKeys,
    ...targetCollections,
    ledgerCollection,
  ]) {
    result[collection] = await count(target, collection);
  }
  return result;
};

const sourceRevision = async (target) => {
  const singleton = await get(
    target,
    '/items/data_operations?fields=source_revision',
  );
  return singleton.source_revision;
};

// Everything a run must leave untouched: item counts, the coordinator's
// source revision and the source fingerprint itself.
const snapshot = async (target, directus) => ({
  counts: await counts(target),
  fingerprint: fingerprintInventory(await readInventory(directus, {})),
  revision: await sourceRevision(target),
});

const withoutId = (row) =>
  Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'id'));

// Assignment rows are seeded without ids, in dataset order, so the table's
// sequence stays ahead of the role rows the migration appends, as it is on
// a deployment filled through the importer; every other collection keeps
// the dataset ids because nothing is appended to it.
const seed = async (target, dataset) => {
  for (const collection of collectionKeys) {
    const rows =
      collection === 'teaching_assignments'
        ? dataset[collection].map((row) => withoutId(row))
        : dataset[collection];
    await read(
      await request(
        target,
        `/items/${collection}`,
        json('POST', rows, target.token),
      ),
      200,
    );
  }
};

const removeAll = async (target, collection) => {
  const rows = await get(target, `/items/${collection}?fields=id&limit=-1`);
  if (rows.length === 0) return;
  await read(
    await request(
      target,
      `/items/${collection}`,
      json(
        'DELETE',
        rows.map(({ id }) => id),
        target.token,
      ),
    ),
    204,
  );
};

const cli = (target) => {
  const stdout = [];
  const stderr = [];
  const environment = {
    DIRECTUS_TOKEN: target.token,
    DIRECTUS_URL: target.base.href,
  };
  const io = {
    createRequest: createDirectusRequest,
    now: () => clockValue,
    runToken: () => 'integration-run',
    stderr: (line) => {
      stderr.push(line);
    },
    stdout: (line) => {
      stdout.push(line);
    },
  };
  return {
    run: (arguments_) => runMigrationCli(arguments_, environment, io),
    stderr,
    stdout,
  };
};

const readReport = async (reportPath) =>
  migrationReportSchema.parse(JSON.parse(await readFile(reportPath, 'utf8')));

// A receipt naming the synthetic backup artifact beside it (a relative
// path resolves against the receipt's directory) with its real size.
const writeReceipt = async ({
  artifact = artifactName,
  directory,
  name,
  sourceFingerprint,
}) => {
  const receiptPath = path.join(directory, name);
  await writeFile(
    receiptPath,
    JSON.stringify({
      artifacts: [
        {
          bytes: artifactContent.length,
          kind: 'database',
          path: artifact,
          sha256: 'c'.repeat(64),
        },
      ],
      createdAt: clockValue,
      sourceFingerprint,
      version: backupReceiptVersion,
    }),
  );
  return receiptPath;
};

const assertAggregateOnly = (line, reportPath) => {
  const summary = JSON.parse(line);
  assert.equal(summary.mode, 'dry-run');
  assert.equal(typeof summary.blockers, 'number');
  assert.equal(typeof summary.counts.collections.courses, 'number');
  for (const forbidden of ['Alpha', 'SYN-', '@', 'Synthetic', reportPath]) {
    assert.ok(!line.includes(forbidden), `stdout must not carry ${forbidden}`);
  }
  return summary;
};

const dryRunReportsBlockers = async (target, directus, directory) => {
  const before = await snapshot(target, directus);
  const run = cli(target);
  const reportPath = path.join(directory, 'report-1.json');
  const exitCode = await run.run(['--dry-run', '--report', reportPath]);
  assert.equal(exitCode, 0, run.stderr.join('\n'));
  assert.deepEqual(run.stderr, []);
  assert.equal(run.stdout.length, 1);
  const summary = assertAggregateOnly(run.stdout[0], reportPath);
  assert.equal(summary.migratable, false);
  assert.equal(summary.blockers, 1);
  assert.deepEqual(summary.findings.ambiguous_student_index, 1);
  assert.deepEqual(summary.counts.collections, {
    course_enrollment_patterns: 3,
    course_equivalencies: 9,
    courses: 8,
    curriculum_2018: 9,
    curriculum_2023: 9,
    deans_office: 2,
    discord_channels: 2,
    moodle_users: 9,
    rooms: 3,
    staff: 3,
    student_council: 4,
    students: 4,
    teaching_assignments: 13 - 6,
  });
  assert.deepEqual(summary.ledger, { completed: [], failed: [], running: [] });
  assert.deepEqual(summary.targets, {
    academic_years: 0,
    course_curricula: 0,
    course_enrollment_rules: 0,
    curriculum_entries: 0,
  });
  const report = await readReport(reportPath);
  assert.deepEqual(
    report.blockers.map(({ code, collection, ids }) => ({
      code,
      collection,
      ids,
    })),
    [
      {
        code: 'ambiguous_student_index',
        collection: 'student_council',
        ids: [1],
      },
    ],
  );
  assert.deepEqual(report.candidates.council[0].student, {
    label: 'SYN-0001',
    matches: [1, 2],
    precedent: 1,
    resolution: 'ambiguous',
  });
  assert.equal(report.candidates.courses.length, 8);
  assert.equal(
    report.candidates.courses.find(({ name }) => name === 'Alpha Course')
      .current.precedent,
    1,
  );
  assert.equal(report.mappings.length > 100, true);
  assert.equal(summary.findings.unknown_source_field, undefined);
  assert.deepEqual(
    report.warnings.filter(({ code }) => code === 'unknown_source_field'),
    [],
    'a fresh install declares every column',
  );
  assert.deepEqual(Object.keys(report.fields).length, collectionKeys.length);
  assert.ok(report.fields.courses.includes('credits_2023'));
  assert.ok(report.fields.teaching_assignments.includes('display_override'));
  assert.deepEqual(
    report.candidates.assignments.map(({ id, staff }) => [
      id,
      staff.map(({ resolution }) => resolution),
    ]),
    [
      [1, ['unresolved', 'unresolved']],
      [2, ['unresolved', 'unresolved']],
      [3, ['unresolved', 'none']],
      [4, ['none', 'unresolved']],
      [5, ['unresolved', 'unresolved']],
      [6, ['unresolved', 'unresolved']],
      [7, ['unresolved', 'unresolved']],
    ],
    'every assignment row carries its staff candidates',
  );
  assert.ok(!JSON.stringify(report).includes('@'));
  assert.ok(!JSON.stringify(report).includes('Synthetic Student'));
  assert.deepEqual(await snapshot(target, directus), before);
  return { fingerprint: report.sourceFingerprint, report: reportPath };
};

const dryRunAfterResolution = async (target, directus, runs) => {
  const { directory, first } = runs;
  await read(
    await request(target, '/items/students/2', {
      method: 'DELETE',
      token: target.token,
    }),
    204,
  );
  const before = await snapshot(target, directus);
  const run = cli(target);
  const reportPath = path.join(directory, 'report-2.json');
  assert.equal(await run.run(['--dry-run', '--report', reportPath]), 0);
  const summary = assertAggregateOnly(run.stdout[0], reportPath);
  assert.equal(summary.migratable, true);
  assert.equal(summary.blockers, 0);
  const report = await readReport(reportPath);
  assert.notEqual(report.sourceFingerprint, first.fingerprint);
  assert.deepEqual(await snapshot(target, directus), before);
  return { fingerprint: report.sourceFingerprint, report: reportPath };
};

const applyRefusals = async (target, directus, runs) => {
  const { directory, first, second } = runs;
  const before = await snapshot(target, directus);
  const missing = cli(target);
  assert.equal(
    await missing.run(
      applyWith(second.report, path.join(directory, 'missing-receipt.json')),
    ),
    1,
  );
  assert.match(missing.stderr.join('\n'), receiptPattern);
  const staleReceipt = await writeReceipt({
    directory,
    name: 'receipt-1.json',
    sourceFingerprint: first.fingerprint,
  });
  const blocked = cli(target);
  assert.equal(await blocked.run(applyWith(first.report, staleReceipt)), 1);
  assert.match(blocked.stderr.join('\n'), blockerPattern);
  const drifted = cli(target);
  assert.equal(await drifted.run(applyWith(second.report, staleReceipt)), 1);
  assert.match(drifted.stderr.join('\n'), fingerprintPattern);
  const noBackup = cli(target);
  assert.equal(
    await noBackup.run(
      applyWith(
        second.report,
        await writeReceipt({
          artifact: 'never-taken.sql',
          directory,
          name: 'receipt-no-artifact.json',
          sourceFingerprint: second.fingerprint,
        }),
      ),
    ),
    1,
  );
  assert.match(noBackup.stderr.join('\n'), missingArtifactPattern);
  assert.deepEqual(await snapshot(target, directus), before);
  assert.equal(before.counts[ledgerCollection], 0);
};

const applyRecordsLedger = async (target, directus, runs) => {
  const { directory, first, second } = runs;
  const before = await snapshot(target, directus);
  const receipt = await writeReceipt({
    directory,
    name: 'receipt-2.json',
    sourceFingerprint: second.fingerprint,
  });
  const run = cli(target);
  const arguments_ = applyWith(second.report, receipt);
  assert.equal(await run.run(arguments_), 0, run.stderr.join('\n'));
  const summary = JSON.parse(run.stdout[0]);
  assert.equal(summary.mode, 'apply');
  assert.equal(summary.converters, 5);
  assert.deepEqual(summary.steps, {
    completed: ['preflight', ...stepNames],
    skipped: [],
  });
  assert.match(summary.message, convertersPattern);
  for (const forbidden of ['Alpha', 'SYN-', '@', 'Synthetic']) {
    assert.ok(
      !run.stdout[0].includes(forbidden),
      `stdout carries ${forbidden}`,
    );
  }
  const after = await snapshot(target, directus);
  assert.equal(
    after.fingerprint,
    before.fingerprint,
    'the converters write target rows and link columns only, never a fingerprinted column',
  );
  assert.deepEqual(
    {
      ...after.counts,
      teaching_assignments: 7,
      ...Object.fromEntries(targetCollections.map((c) => [c, 0])),
      [ledgerCollection]: 0,
    },
    { ...before.counts, teaching_assignments: 7 },
    'no checkpoint row was removed',
  );
  for (const [collection, expected] of Object.entries(migratedCounts)) {
    assert.equal(after.counts[collection], expected, collection);
  }
  assert.equal(after.counts[ledgerCollection], 6);
  const [row] = await get(
    target,
    `/items/${ledgerCollection}?fields=key,version,step,status,source_fingerprint,run_token,started_at,finished_at,error&filter[step][_eq]=preflight`,
  );
  assert.deepEqual(row, {
    error: null,
    finished_at: clockValue,
    key: 'relational-1/preflight',
    run_token: 'integration-run',
    source_fingerprint: second.fingerprint,
    started_at: clockValue,
    status: 'completed',
    step: 'preflight',
    version: 'relational-1',
  });
  const again = cli(target);
  assert.equal(await again.run(arguments_), 0);
  assert.deepEqual(JSON.parse(again.stdout[0]).steps, {
    completed: [],
    skipped: ['preflight', ...stepNames],
  });
  assert.deepEqual(JSON.parse(again.stdout[0]).written, {});
  assert.equal(await count(target, ledgerCollection), 6);
  const unchanged = await snapshot(target, directus);
  assert.deepEqual(unchanged.counts, after.counts);
  const drift = cli(target);
  assert.equal(
    await drift.run(
      applyWith(
        first.report,
        await writeReceipt({
          directory,
          name: 'receipt-3.json',
          sourceFingerprint: first.fingerprint,
        }),
      ),
    ),
    1,
  );
  assert.match(drift.stderr.join('\n'), blockerPattern);
  const summaryDrift = cli(target);
  const forged = path.join(directory, 'report-forged.json');
  const forgedReport = await readReport(second.report);
  await writeFile(
    forged,
    JSON.stringify({ ...forgedReport, sourceFingerprint: 'd'.repeat(64) }),
  );
  assert.equal(
    await summaryDrift.run(
      applyWith(
        forged,
        await writeReceipt({
          directory,
          name: 'receipt-4.json',
          sourceFingerprint: 'd'.repeat(64),
        }),
      ),
    ),
    1,
  );
  assert.match(summaryDrift.stderr.join('\n'), driftPattern);
  assert.equal(await count(target, ledgerCollection), 6);
};

// The preflight step's row, the one the re-claim scenario manipulates.
const ledgerRow = async (target) => {
  const [row] = await get(
    target,
    `/items/${ledgerCollection}?fields=id,status,run_token,error,id_map&filter[step][_eq]=preflight`,
  );
  return row;
};

// The recorded step is re-claimed through the conditional update Directus
// applies by query: a failed row is taken over, a running row refuses
// without --resume, and a stale owner's update matches nothing.
const applyReclaimsLedger = async (target, directus, runs) => {
  const { directory, second } = runs;
  const receipt = await writeReceipt({
    directory,
    name: 'receipt-5.json',
    sourceFingerprint: second.fingerprint,
  });
  const arguments_ = applyWith(second.report, receipt);
  const before = await ledgerRow(target);
  assert.equal(before.status, 'completed');
  await read(
    await request(
      target,
      `/items/${ledgerCollection}/${before.id}`,
      json(
        'PATCH',
        {
          error: 'synthetic interruption',
          run_token: 'other-run',
          status: 'failed',
        },
        target.token,
      ),
    ),
    200,
  );
  const reclaim = cli(target);
  assert.equal(await reclaim.run(arguments_), 0, reclaim.stderr.join('\n'));
  assert.deepEqual(JSON.parse(reclaim.stdout[0]).steps, {
    completed: ['preflight'],
    skipped: stepNames,
  });
  assert.equal(await count(target, ledgerCollection), 6);
  const reclaimed = await ledgerRow(target);
  assert.equal(reclaimed.error, null);
  assert.equal(reclaimed.run_token, 'integration-run');
  assert.equal(reclaimed.status, 'completed');
  await read(
    await request(
      target,
      `/items/${ledgerCollection}/${before.id}`,
      json(
        'PATCH',
        { run_token: 'other-run', status: 'running' },
        target.token,
      ),
    ),
    200,
  );
  const held = cli(target);
  assert.equal(await held.run(arguments_), 1);
  assert.match(held.stderr.join('\n'), resumePattern);
  const heldRow = await ledgerRow(target);
  assert.equal(heldRow.run_token, 'other-run');
  assert.equal(
    await fencedPatch(
      directus,
      { id: before.id, run_token: 'stale-run', status: 'running' },
      { status: 'completed' },
    ),
    false,
    'a stale owner matches no row',
  );
  const untouched = await ledgerRow(target);
  assert.equal(untouched.status, 'running');
  assert.equal(untouched.run_token, 'other-run');
  const resumed = cli(target);
  assert.equal(
    await resumed.run([...arguments_, '--resume']),
    0,
    resumed.stderr.join('\n'),
  );
  const resumedRow = await ledgerRow(target);
  assert.equal(resumedRow.run_token, 'integration-run');
  assert.equal(resumedRow.status, 'completed');
  assert.equal(await count(target, ledgerCollection), 6);
  const after = await snapshot(target, directus);
  for (const [collection, expected] of Object.entries(migratedCounts)) {
    assert.equal(after.counts[collection], expected, `${collection} unchanged`);
  }
};

// Target rows go first (their links reference entries and years), then the
// checkpoint rows the migration linked.
const cleanup = async (target) => {
  await removeAll(target, ledgerCollection);
  for (const collection of [
    'course_enrollment_rules',
    'course_curricula',
    'curriculum_entry_program_states',
    'course_equivalency_members',
    'curriculum_entries',
    'study_programs',
    'curriculum_generations',
    'academic_years',
    ...collectionKeys,
  ]) {
    await removeAll(target, collection);
  }
  const remaining = await counts(target);
  for (const [collection, value] of Object.entries(remaining)) {
    assert.equal(value, 0, `${collection} must be empty after cleanup`);
  }
};

test('preflights and applies the relational migration on the fixture without mutating the source', async (t) => {
  const target = targetFrom(process.env);
  const directus = adminRequest(target);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'migration-preflight-'),
  );
  await writeFile(path.join(directory, artifactName), artifactContent);
  const runs = new Map();
  try {
    await withDataModel(target, async () => {
      await installDataModel(directus);
      await applySchemaConstraints(directus);
      await applySourceInvalidation(directus);
      await seed(target, seedDataset());
      try {
        await t.test(
          'dry-run reports the duplicate index as a blocker with aggregate counts only and mutates nothing',
          async () => {
            runs.set(
              'first',
              await dryRunReportsBlockers(target, directus, directory),
            );
          },
        );
        await t.test(
          'dry-run after the duplicate is resolved is migratable',
          async () => {
            runs.set(
              'second',
              await dryRunAfterResolution(target, directus, {
                directory,
                first: runs.get('first'),
              }),
            );
          },
        );
        const outcomes = {
          directory,
          first: runs.get('first'),
          second: runs.get('second'),
        };
        await t.test(
          'apply refuses a missing receipt, a blocked report and a stale receipt',
          () => applyRefusals(target, directus, outcomes),
        );
        await t.test(
          'apply records the preflight step in the ledger and writes no target row',
          () => applyRecordsLedger(target, directus, outcomes),
        );
        await t.test(
          'apply re-claims a failed step and refuses a held one through conditional updates',
          () => applyReclaimsLedger(target, directus, outcomes),
        );
      } finally {
        await t.test('removes every seeded row and ledger row', () =>
          cleanup(target),
        );
      }
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
  assert.equal(runs.size, 2);
});
