import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { deriveCourses } from '../../directus/extensions/directus-extension-rebuild-derived-data/derive.js';
import serializeAssets from '../../directus/flows/serialize-assets.cjs';
import {
  applySchemaConstraints,
  applySourceInvalidation,
} from '../../src/data-model/constraints.js';
import { installDataModel } from '../../src/data-model/install.js';
import { createDirectusRequest } from '../../src/directus-request.js';
import {
  ConverterWriteError,
  createRows,
} from '../../src/migrations/batches.js';
import { fingerprintInventory } from '../../src/migrations/fingerprint.js';
import { readInventory } from '../../src/migrations/inventory.js';
import { ledgerCollection } from '../../src/migrations/ledger-claim.js';
import { migrationReportSchema } from '../../src/migrations/report.js';
import { runMigrationCli } from '../../src/migrations/run.js';
import { collectionSpecs } from '../../src/model.js';
import { collectionKeys } from '../../src/schema.js';
import { makeSyntheticDataset } from '../fixtures/synthetic-data.js';
import { targetFrom } from '../search-integration-helpers.mjs';
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
];
const stepNames = [
  'curricula',
  'rules',
  'assignments',
  'council',
  'equivalencies',
];
const backupReceiptVersion = 'backup-receipt-1';
const clockValue = '2026-09-22T12:00:00.000Z';
const artifactName = 'synthetic-backup.sql';
const artifactContent = 'synthetic backup';
const batchSize = 5;
const originalAssignments = 10;
// An unresolved text longer than a varchar(255): the review row must carry
// it verbatim, which needs display_override to be a text column.
const longProfessors = Array.from(
  { length: 40 },
  (_, index) => `Prof. Synthetic ${index}`,
).join(' & ');
const outage = 'synthetic outage after the first batch';
const outagePattern = /synthetic outage/u;
const failedPattern = /^Migration failed: Step curricula failed: /u;
const forbiddenOnStdout = ['Alpha', 'SYN-', '@', 'Synthetic', 'Twin'];
const collator = new Intl.Collator('en');

// Staff rows added so the fixture exercises every staff resolution: two
// complete labels split on a comma, two whole-text labels, and a label two
// staff rows carry.
const extraStaff = [
  'Prof. Theta',
  'Asst. Theta',
  'Prof. Twin',
  'Prof. Twin',
  'Prof. Zed Alpha',
  'Prof. Abe Alpha',
].map((name, index) => ({
  active: true,
  cabinet: null,
  consultations: null,
  courses: null,
  email: null,
  id: 4 + index,
  name,
  position: null,
  profile: null,
  title: null,
}));

// The synthetic dataset with the ambiguities the migration must refuse
// removed (a repeated curriculum name per generation, an equivalency row
// carrying a second 2018 label) and every retained peculiarity kept: the
// orphan curriculum rows of both generations, the 2013-only equivalency,
// the orphan equivalency, assignment and pattern rows, the superseded
// pattern row, the duplicate assignment row, and two duplicate student
// indexes: one a council row references (a blocker until resolved) and one
// nothing references (retained through the migration).
const seedDataset = () => {
  const base = makeSyntheticDataset();
  return {
    ...base,
    course_equivalencies: base.course_equivalencies.filter(
      (row) => row.id !== 2,
    ),
    curriculum_2018: base.curriculum_2018.filter((row) => row.id !== 9),
    curriculum_2023: base.curriculum_2023.filter((row) => row.id !== 2),
    staff: [...base.staff, ...extraStaff],
    students: [
      ...base.students,
      {
        id: 5,
        index_number: 'SYN-0042',
        name: 'Synthetic Twin A',
        source_group: 'synthetic',
      },
      {
        id: 6,
        index_number: 'SYN-0042',
        name: 'Synthetic Twin B',
        source_group: 'synthetic',
      },
    ],
    teaching_assignments: [
      ...base.teaching_assignments,
      {
        assistants: null,
        course_name: 'Delta Course',
        id: 9,
        professors: 'Prof. Twin',
      },
      {
        assistants: null,
        course_name: 'Gamma Course',
        id: 10,
        professors: longProfessors,
      },
    ],
  };
};

const seededCounts = {
  course_enrollment_patterns: 4,
  course_equivalencies: 9,
  courses: 8,
  curriculum_2018: 9,
  curriculum_2023: 9,
  deans_office: 2,
  discord_channels: 2,
  moodle_users: 9,
  rooms: 3,
  staff: 9,
  student_council: 4,
  students: 6,
  teaching_assignments: originalAssignments,
};

// What the five steps write for the seeded dataset.
const written = {
  academic_years: 15,
  course_curricula: 12,
  course_enrollment_rules: 8 * 15,
  course_equivalencies: 8,
  curriculum_entries: 18,
  student_council: 3,
  teaching_assignments: 15,
};

const unresolved = {
  ambiguous_staff_label: 1,
  duplicate_pattern: 1,
  orphan_assignment: 1,
  orphan_equivalency: 3,
  orphan_pattern: 1,
  unlinked_generation_values: 1,
  unmatched_council_index: 1,
  unmatched_equivalency_entry: 2,
  unresolved_staff_text: 10,
};

const specFields = (collection) =>
  collectionSpecs
    .find((spec) => spec.key === collection)
    .fields.map(({ target }) => target);

const withoutId = (row) =>
  Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'id'));

const get = async (target, pathname) => {
  const body = await read(
    await request(target, pathname, { token: target.token }),
    200,
  );
  return body.data;
};

const list = (target, collection, fields) =>
  get(
    target,
    `/items/${collection}?fields=${encodeURIComponent(fields.join(','))}&sort=id&limit=-1`,
  );

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

// The scalar columns of every checkpoint row (the spec columns, never the
// link columns the migration sets), the four public serializations and the
// source fingerprint: everything the migration must leave as it found it.
const checkpointSnapshot = async (target, directus) => {
  const rows = {};
  for (const collection of collectionKeys) {
    rows[collection] = await list(target, collection, [
      'id',
      ...specFields(collection),
    ]);
  }
  return {
    fingerprint: fingerprintInventory(await readInventory(directus, {})),
    rows,
    serialized: serializeAssets({
      read_courses: rows.courses,
      read_rooms: rows.rooms,
      read_staff: rows.staff,
      read_students: rows.students,
    }),
  };
};

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
  const assigned = await list(target, 'teaching_assignments', ['id']);
  assert.deepEqual(
    assigned.map(({ id }) => id),
    dataset.teaching_assignments.map(({ id }) => id),
    'the sequence hands out the dataset ids',
  );
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

// The CLI over the real request, optionally through a wrapper that fails
// the second POST batch to one collection.
const cli = (target, failing = null) => {
  const stdout = [];
  const stderr = [];
  const environment = {
    DIRECTUS_TOKEN: target.token,
    DIRECTUS_URL: target.base.href,
  };
  let posts = 0;
  const createRequest = (config) => {
    const real = createDirectusRequest(config);
    if (failing === null) return real;
    return (pathname, init) => {
      if (init?.method === 'POST' && pathname.startsWith(`/items/${failing}`)) {
        posts += 1;
        if (posts === 2) return Promise.reject(new Error(outage));
      }
      return real(pathname, init);
    };
  };
  const io = {
    batchSize,
    createRequest,
    now: () => clockValue,
    runToken: () => `integration-run-${failing === null ? 'clean' : 'failing'}`,
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

const writeReceipt = async ({ directory, name, sourceFingerprint }) => {
  const receiptPath = path.join(directory, name);
  await writeFile(
    receiptPath,
    JSON.stringify({
      artifacts: [
        {
          bytes: artifactContent.length,
          kind: 'database',
          path: artifactName,
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

const applyWith = (report, receipt) => [
  '--apply',
  '--report',
  report,
  '--backup-receipt',
  receipt,
];

const assertAggregateOnly = (line) => {
  for (const forbidden of forbiddenOnStdout) {
    assert.ok(!line.includes(forbidden), `stdout must not carry ${forbidden}`);
  }
  return JSON.parse(line);
};

const findingCodes = (findings) =>
  findings.map(({ code }) => code).toSorted(collator.compare);

const countOf = (findings, code) =>
  findings.filter((finding) => finding.code === code).length;

const dryRunShowsBlockers = async (target, directory) => {
  const run = cli(target);
  const reportPath = path.join(directory, 'report-1.json');
  assert.equal(await run.run(['--dry-run', '--report', reportPath]), 0);
  const summary = assertAggregateOnly(run.stdout[0]);
  assert.equal(summary.migratable, false);
  assert.equal(summary.blockers, 1);
  assert.deepEqual(summary.counts.collections, seededCounts);
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
  const warnings = findingCodes(report.warnings);
  for (const code of [
    'duplicate_student_index',
    'duplicate_assignment',
    'duplicate_pattern',
    'duplicate_staff_name',
    'orphan_assignment',
    'orphan_equivalency',
    'orphan_pattern',
    'unreferenced_rows',
    'ambiguous_staff_label',
    'unlinked_generation_values',
  ]) {
    assert.ok(warnings.includes(code), `warning ${code} is visible`);
  }
  assert.equal(
    countOf(report.warnings, 'duplicate_student_index'),
    2,
    'both duplicate index groups are visible and retained',
  );
  return { fingerprint: report.sourceFingerprint, report: reportPath };
};

const dryRunAfterResolution = async (target, directory) => {
  await read(
    await request(target, '/items/students/2', {
      method: 'DELETE',
      token: target.token,
    }),
    204,
  );
  const run = cli(target);
  const reportPath = path.join(directory, 'report-2.json');
  assert.equal(await run.run(['--dry-run', '--report', reportPath]), 0);
  const summary = assertAggregateOnly(run.stdout[0]);
  assert.equal(summary.migratable, true);
  assert.equal(summary.blockers, 0);
  const report = await readReport(reportPath);
  assert.equal(
    countOf(report.warnings, 'duplicate_student_index'),
    1,
    'the unreferenced duplicate index stays retained',
  );
  return { fingerprint: report.sourceFingerprint, report: reportPath };
};

const applyFailsAfterFirstBatch = async (target, directus, runs) => {
  const { before, directory, second } = runs;
  const receipt = await writeReceipt({
    directory,
    name: 'receipt-2.json',
    sourceFingerprint: second.fingerprint,
  });
  const run = cli(target, 'curriculum_entries');
  assert.equal(await run.run(applyWith(second.report, receipt)), 1);
  assert.match(run.stderr.join('\n'), failedPattern);
  assert.match(run.stderr.join('\n'), outagePattern);
  const ledger = await get(
    target,
    `/items/${ledgerCollection}?fields=step,status,error,id_map&sort=id`,
  );
  assert.deepEqual(
    ledger.map(({ status, step }) => [step, status]),
    [
      ['preflight', 'completed'],
      ['curricula', 'failed'],
    ],
  );
  assert.match(ledger[1].error, outagePattern);
  assert.equal(
    ledger[1].id_map.length,
    batchSize,
    'the first batch is recorded',
  );
  assert.equal(await count(target, 'curriculum_entries'), batchSize);
  assert.equal(await count(target, 'course_curricula'), 0);
  const after = await checkpointSnapshot(target, directus);
  assert.equal(
    after.fingerprint,
    before.fingerprint,
    'no source column changed',
  );
  return receipt;
};

const assertEntriesAndLinks = async (target) => {
  const entries = await list(target, 'curriculum_entries', [
    'id',
    'generation',
    'name',
    'source_collection',
    'source_id',
    'state_ie',
    'state_ke',
  ]);
  const provenance = entries.map(
    (row) => `${row.source_collection}/${row.source_id}`,
  );
  assert.equal(new Set(provenance).size, 18, 'no entry was created twice');
  assert.ok(entries.some((row) => row.name === 'Orphan Current Course'));
  assert.ok(entries.some((row) => row.name === 'Orphan Legacy Course'));
  assert.ok(
    entries.every((row) =>
      row.generation === '2023' ? row.state_ke === null : row.state_ie === null,
    ),
  );
  const links = await list(target, 'course_curricula', [
    'id',
    'course',
    'entry',
    'generation',
    'credits',
    'available',
  ]);
  const linkOf = (course, generation) =>
    links.find((row) => row.course === course && row.generation === generation);
  const nameOf = (entry) => entries.find((row) => row.id === entry).name;
  assert.equal(
    new Set(links.map((row) => `${row.course}/${row.generation}`)).size,
    12,
  );
  const alphaCurrent = linkOf(1, '2023');
  assert.deepEqual(
    { available: alphaCurrent.available, credits: alphaCurrent.credits },
    { available: true, credits: 6 },
  );
  assert.equal(nameOf(alphaCurrent.entry), 'Alpha Course (2023)');
  assert.equal(nameOf(linkOf(2, '2018').entry), 'Beta Legacy Manual');
  assert.equal(
    linkOf(3, '2018'),
    undefined,
    'a 2013-only equivalency links no legacy entry',
  );
  return { alphaCurrent, entries };
};

const assertRules = async (target) => {
  const rules = await list(target, 'course_enrollment_rules', [
    'course',
    'academic_year',
    'mode',
    'pattern',
    'source_collection',
    'source_id',
  ]);
  const years = await list(target, 'academic_years', ['id', 'label']);
  const yearId = (label) => years.find((year) => year.label === label).id;
  const ruleOf = (course, label) =>
    rules.find(
      (rule) => rule.course === course && rule.academic_year === yearId(label),
    );
  assert.ok(rules.every((rule) => rule.mode === 'legacy_regex'));
  assert.deepEqual(
    ruleOf(1, '2025/2026'),
    {
      academic_year: yearId('2025/2026'),
      course: 1,
      mode: 'legacy_regex',
      pattern: 'Alpha Honors-2025/2026',
      source_collection: 'course_enrollment_patterns',
      source_id: 2,
    },
    'the last ascending pattern row wins and is named as provenance',
  );
  assert.deepEqual(
    ruleOf(4, '2021/2022'),
    {
      academic_year: yearId('2021/2022'),
      course: 4,
      mode: 'legacy_regex',
      pattern: 'Delta Course-2021/2022',
      source_collection: 'courses',
      source_id: 4,
    },
    'the default pattern is recorded literally with the course as provenance',
  );
};

const assertAssignments = async (target) => {
  const assignments = await list(target, 'teaching_assignments', [
    'id',
    'course',
    'course_name',
    'professors',
    'assistants',
    'staff',
    'role',
    'sort',
    'display_override',
    'source_collection',
    'source_id',
  ]);
  const originals = assignments.filter((row) => row.source_collection === null);
  const roleRows = assignments.filter(
    (row) => row.source_collection === 'teaching_assignments',
  );
  assert.equal(originals.length, originalAssignments);
  assert.equal(roleRows.length, written.teaching_assignments);
  assert.ok(
    roleRows.every(
      (row) =>
        row.id > originalAssignments &&
        row.professors === null &&
        row.assistants === null &&
        row.course !== null,
    ),
  );
  assert.equal(
    new Set(roleRows.map((row) => `${row.source_id}/${row.role}/${row.sort}`))
      .size,
    roleRows.length,
    'no role row was created twice',
  );
  assert.deepEqual(
    roleRows
      .filter((row) => row.source_id === 1)
      .map(({ display_override, role, sort, staff }) => [
        role,
        sort,
        staff,
        display_override,
      ]),
    [
      ['professor', 1, 8, null],
      ['professor', 2, 9, null],
      ['assistant', 1, null, 'Asst. Alpha One; Asst. Alpha Two'],
    ],
    'complete labels link in text order, the rest is retained verbatim',
  );
  assert.deepEqual(
    roleRows
      .filter((row) => row.source_id === 9)
      .map(({ display_override, staff }) => [staff, display_override]),
    [[null, 'Prof. Twin']],
    'a label two staff rows carry is retained, not guessed',
  );
  assert.ok(longProfessors.length > 255);
  assert.deepEqual(
    roleRows
      .filter((row) => row.source_id === 10)
      .map(({ display_override, staff }) => [staff, display_override]),
    [[null, longProfessors]],
    'a long unresolved text is retained verbatim in the text column',
  );
  assert.ok(
    originals.every((row) => row.course === null),
    'original rows keep their text and gain no link',
  );
  return { assignments, originals };
};

const assertLinks = async (target) => {
  const council = await list(target, 'student_council', [
    'id',
    'index_number',
    'student',
  ]);
  assert.deepEqual(
    council.map(({ id, student }) => [id, student]),
    [
      [1, 1],
      [2, null],
      [3, 3],
      [4, 4],
    ],
  );
  const equivalencies = await list(target, 'course_equivalencies', [
    'id',
    'course',
    'entry_2023',
    'entry_2018',
    'course_2013',
  ]);
  assert.deepEqual(
    equivalencies.map(({ course, entry_2018, entry_2023, id }) => [
      id,
      course,
      entry_2023 !== null,
      entry_2018 !== null,
    ]),
    [
      [1, 1, true, true],
      [3, null, true, false],
      [4, 2, true, true],
      [5, 3, true, false],
      [6, 5, true, true],
      [7, 6, true, true],
      [8, 7, true, true],
      [9, null, false, true],
      [10, null, false, false],
    ],
  );
  assert.equal(
    equivalencies.find((row) => row.id === 10).course_2013,
    'Ancient Only',
    'the 2013 label is retained',
  );
};

// The old rows, the four public serializations and the fingerprint are as
// they were before the apply, and the checkpoint derivation, run over the
// fixture as it is now, still displays the original text rows because every
// role row has a higher id.
const assertUntouched = async (target, directus, runs) => {
  const { assignments, before, originals } = runs;
  const snapshot = await checkpointSnapshot(target, directus);
  assert.equal(snapshot.fingerprint, before.fingerprint);
  assert.deepEqual(
    snapshot.serialized,
    before.serialized,
    'the four public serializations are unchanged',
  );
  for (const collection of collectionKeys) {
    const rows =
      collection === 'teaching_assignments'
        ? snapshot.rows[collection].slice(0, originalAssignments)
        : snapshot.rows[collection];
    assert.deepEqual(
      rows,
      before.rows[collection],
      `${collection} scalar columns unchanged`,
    );
  }
  const sources = {
    courseEnrollmentPatterns: snapshot.rows.course_enrollment_patterns,
    courseEquivalencies: snapshot.rows.course_equivalencies,
    courses: snapshot.rows.courses,
    curriculum2018: snapshot.rows.curriculum_2018,
    curriculum2023: snapshot.rows.curriculum_2023,
    moodleUsers: snapshot.rows.moodle_users,
    teachingAssignments: originals,
  };
  assert.deepEqual(
    await deriveCourses({ ...sources, teachingAssignments: assignments }),
    await deriveCourses(sources),
    'the old derivation is unchanged by the role rows',
  );
};

const applyResumesWithoutDuplicates = async (target, directus, runs) => {
  const { before, receipt, second } = runs;
  const run = cli(target);
  assert.equal(
    await run.run(applyWith(second.report, receipt)),
    0,
    run.stderr.join('\n'),
  );
  const summary = assertAggregateOnly(run.stdout[0]);
  assert.equal(summary.converters, 5);
  assert.deepEqual(summary.steps, {
    completed: stepNames,
    skipped: ['preflight'],
  });
  assert.deepEqual(
    {
      ...summary.written,
      curriculum_entries: summary.written.curriculum_entries + batchSize,
    },
    written,
    'the resumed run wrote only what the interrupted run had not',
  );
  assert.deepEqual(summary.unresolved, unresolved);
  const after = await counts(target);
  assert.deepEqual(after, {
    ...seededCounts,
    academic_years: written.academic_years,
    course_curricula: written.course_curricula,
    course_enrollment_rules: written.course_enrollment_rules,
    curriculum_entries: written.curriculum_entries,
    [ledgerCollection]: 6,
    students: 5,
    teaching_assignments: originalAssignments + written.teaching_assignments,
  });
  const { alphaCurrent, entries } = await assertEntriesAndLinks(target);
  await assertRules(target);
  const { assignments, originals } = await assertAssignments(target);
  await assertLinks(target);
  await assertUntouched(target, directus, { assignments, before, originals });
  const again = cli(target);
  assert.equal(
    await again.run(applyWith(second.report, receipt)),
    0,
    again.stderr.join('\n'),
  );
  assert.deepEqual(JSON.parse(again.stdout[0]).steps, {
    completed: [],
    skipped: ['preflight', ...stepNames],
  });
  assert.deepEqual(JSON.parse(again.stdout[0]).written, {});
  assert.deepEqual(
    await counts(target),
    after,
    'a second apply writes nothing',
  );
  return { alphaCurrent, entries };
};

// A write the model forbids is a converter bug the batch writer names,
// never a condition to retry: the composite key and the generation guard
// both answer through it on the real database.
const currentLink = (course, entry) => ({
  available: null,
  course,
  credits: null,
  entry,
  generation: '2023',
  sort: 1,
});

const constraintsSurfaceAsConverterBugs = async (directus, outcome) => {
  const { alphaCurrent, entries } = outcome;
  const legacy = entries.find((row) => row.generation === '2018');
  const rejects = (record, code) =>
    assert.rejects(
      createRows(directus, {
        collection: 'course_curricula',
        fields: ['course', 'generation'],
        records: [record],
      }),
      (error) =>
        error instanceof ConverterWriteError && error.message.includes(code),
    );
  await rejects(currentLink(1, alphaCurrent.entry), 'RECORD_NOT_UNIQUE');
  await rejects(currentLink(4, legacy.id), 'INVALID_FOREIGN_KEY');
};

// Target rows go first (their links reference entries and years), then the
// checkpoint rows the migration linked.
const cleanup = async (target) => {
  await removeAll(target, ledgerCollection);
  for (const collection of [
    'course_enrollment_rules',
    'course_curricula',
    'curriculum_entries',
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

const scenarios = async (t, { directory, directus, target }) => {
  const runs = new Map();
  await t.test(
    'dry-run shows the council blocker and the retained duplicates and orphans',
    async () => {
      runs.set('first', await dryRunShowsBlockers(target, directory));
    },
  );
  await t.test(
    'resolving the referenced duplicate makes the run migratable while the other stays',
    async () => {
      runs.set('second', await dryRunAfterResolution(target, directory));
      runs.set('before', await checkpointSnapshot(target, directus));
    },
  );
  await t.test(
    'an outage after the first batch leaves a failed, resumable ledger step',
    async () => {
      runs.set(
        'receipt',
        await applyFailsAfterFirstBatch(target, directus, {
          before: runs.get('before'),
          directory,
          second: runs.get('second'),
        }),
      );
    },
  );
  await t.test(
    'the resumed apply writes every target once and leaves the old rows and exports untouched',
    async () => {
      runs.set(
        'outcome',
        await applyResumesWithoutDuplicates(target, directus, {
          before: runs.get('before'),
          receipt: runs.get('receipt'),
          second: runs.get('second'),
        }),
      );
    },
  );
  await t.test(
    'the composite key and the generation guard reject a bad link as a converter bug',
    () => constraintsSurfaceAsConverterBugs(directus, runs.get('outcome')),
  );
  return runs;
};

test('migrates the seeded checkpoint additively on the fixture, resumes after an interruption without duplicates and leaves the old rows untouched', async (t) => {
  const target = targetFrom(process.env);
  const directus = adminRequest(target);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'relational-migration-'),
  );
  await writeFile(path.join(directory, artifactName), artifactContent);
  let runs = new Map();
  try {
    await withDataModel(target, async () => {
      await installDataModel(directus);
      await applySchemaConstraints(directus);
      await applySourceInvalidation(directus);
      await seed(target, seedDataset());
      try {
        runs = await scenarios(t, { directory, directus, target });
      } finally {
        await t.test('removes every seeded, migrated and ledger row', () =>
          cleanup(target),
        );
      }
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
  assert.ok(runs.has('outcome'), 'every scenario ran');
});
