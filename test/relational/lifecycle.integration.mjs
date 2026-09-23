import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import {
  checkpointPreset,
  searchBookmark,
} from '../../src/checkpoint-presets.js';
import { findModelCollection } from '../../src/data-model/collections.js';
import { derivedDataFlowId } from '../../src/derived-data-flow.js';
import { createDirectusRequest } from '../../src/directus-request.js';
import { toApiField } from '../../src/directus.js';
import { legacyEnrollmentFlows } from '../../src/flows/count-legacy-enrollments.js';
import { mappedEnrollmentFlows } from '../../src/flows/count-mapped-enrollments.js';
import { historyIndexFlows } from '../../src/flows/index-histories.js';
import { markPendingFlowId } from '../../src/flows/mark-pending.js';
import { publicationFlows } from '../../src/flows/prepare-public-assets.js';
import { automaticProcessingFlows } from '../../src/flows/process-pending.js';
import { snapshotImportFlows } from '../../src/flows/snapshot-import.js';
import { runImportCli } from '../../src/import-run.js';
import { countApplicationRecords } from '../../src/import-state.js';
import { exitCodes } from '../../src/lifecycle.js';
import { ledgerCollection } from '../../src/migrations/ledger-claim.js';
import { runMigrationCli } from '../../src/migrations/run.js';
import { collectionSpecs } from '../../src/model.js';
import { publicAssetsFlowId } from '../../src/public-assets-flow.js';
import { runSetup } from '../../src/setup.js';
import { countMigrationData, loadMigrationData } from '../../src/workbook.js';
import {
  lifecycleDataset,
  syntheticWorkbook,
} from '../fixtures/synthetic-workbook.js';
import { targetFrom } from '../search-integration-helpers.mjs';
import {
  adminRequest,
  destroyDataModel,
  json,
  pauseAutomaticProcessing,
  read,
  recording,
  request,
  userCollections,
  withDataModel,
} from './data-model-helpers.mjs';

const clockValue = '2026-09-22T12:00:00.000Z';
const artifactName = 'synthetic-backup.sql';
const artifactContent = 'synthetic backup';
const stepNames = [
  'preflight',
  'curricula',
  'rules',
  'assignments',
  'council',
  'equivalencies',
];
const checkpointFlowIds = [derivedDataFlowId, publicAssetsFlowId];
const setupFlows = [
  ...historyIndexFlows,
  ...snapshotImportFlows,
  ...mappedEnrollmentFlows,
  ...legacyEnrollmentFlows,
  ...publicationFlows,
  ...automaticProcessingFlows,
];
const templateFlowIds = new Set([
  ...checkpointFlowIds,
  ...setupFlows.map(({ id }) => id),
]);
const forbiddenOnStdout = ['Alpha', 'SYN-', '@', 'Synthetic', 'SENTINEL'];
const nothingSentPattern = /Nothing was sent to Directus\.$/u;
const migrationEndpointPattern = /^\/finki-hub-data-operations\/migrations\//u;
// Relation-free checkpoint collections whose ids the target rows reference.
const referenced = [
  'courses',
  'staff',
  'students',
  'course_enrollment_patterns',
  'curriculum_2023',
  'curriculum_2018',
  'student_council',
  'course_equivalencies',
];

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

// The records of a collection; for teaching_assignments only the original
// text rows, beside which the conversion appends its role-bearing rows.
const count = async (target, collection) => {
  const originals =
    collection === 'teaching_assignments'
      ? '&filter[source_collection][_null]=true'
      : '';
  const rows = await get(
    target,
    `/items/${collection}?aggregate[count]=*${originals}`,
  );
  return Number(rows[0].count);
};

const modelFields = (collection) => [
  'id',
  ...findModelCollection(collection).fields.map(({ field }) => field),
];

const environment = (target, workbookPath) => ({
  DIRECTUS_TOKEN: target.token,
  DIRECTUS_URL: target.base.href,
  WORKBOOK_PATH: workbookPath,
});

// A CLI io over the real request that records every request it issues.
const cliIo = (runToken) => {
  const calls = [];
  const stdout = [];
  const stderr = [];
  const io = {
    createRequest: (config) => {
      const real = createDirectusRequest(config);
      return (pathname, init, mode) => {
        calls.push({ method: init?.method ?? 'GET', pathname });
        return real(pathname, init, mode);
      };
    },
    now: () => clockValue,
    runToken: () => runToken,
    stderr: (line) => {
      stderr.push(line);
    },
    stdout: (line) => {
      stdout.push(line);
    },
  };
  return {
    calls,
    io,
    mutations: () => calls.filter(({ method }) => method !== 'GET'),
    stderr,
    stdout,
  };
};

const importCli = (target, workbookPath) => {
  const cli = cliIo('lifecycle-import');
  return {
    ...cli,
    run: () => runImportCli([], environment(target, workbookPath), cli.io),
  };
};

const migrateCli = (target, workbookPath) => {
  const cli = cliIo('lifecycle-upgrade');
  return {
    ...cli,
    run: (arguments_) =>
      runMigrationCli(arguments_, environment(target, workbookPath), cli.io),
  };
};

const aggregateOnly = (line) => {
  for (const forbidden of forbiddenOnStdout) {
    assert.ok(!line.includes(forbidden), `stdout must not carry ${forbidden}`);
  }
  return JSON.parse(line);
};

const ordinals = (rows) =>
  new Map(rows.map(({ id }, index) => [id, index + 1]));

const withoutId = (row) =>
  Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'id'));

// The relational rows of the project with every id replaced by the position
// of the row it names (a checkpoint row's rank by id, an entry's source, a
// year's label): the two lifecycle paths hand out different ids, so only
// this normalised form can be compared.
const normalizedTargets = async (target) => {
  const ids = {};
  for (const collection of referenced) {
    ids[collection] = ordinals(await list(target, collection, ['id']));
  }
  const assignments = await list(
    target,
    'teaching_assignments',
    modelFields('teaching_assignments'),
  );
  ids.teaching_assignments = ordinals(
    assignments.filter((row) => row.source_collection === null),
  );
  const ref = (collection, id) =>
    id === null ? null : (ids[collection].get(id) ?? `missing ${id}`);
  const years = await list(target, 'academic_years', ['id', 'label', 'sort']);
  const yearLabel = new Map(years.map((row) => [row.id, row.label]));
  const entries = await list(
    target,
    'curriculum_entries',
    modelFields('curriculum_entries'),
  );
  const entryKeys = new Map(
    entries.map((row) => [
      row.id,
      `${row.source_collection}#${ref(row.source_collection, row.source_id)}`,
    ]),
  );
  const entryRef = (id) => (id === null ? null : entryKeys.get(id));
  const links = await list(
    target,
    'course_curricula',
    modelFields('course_curricula'),
  );
  const rules = await list(
    target,
    'course_enrollment_rules',
    modelFields('course_enrollment_rules'),
  );
  const council = await list(target, 'student_council', ['id', 'student']);
  const equivalencies = await list(target, 'course_equivalencies', [
    'id',
    'course',
    'entry_2023',
    'entry_2018',
  ]);
  return {
    academic_years: years.map((row) => withoutId(row)),
    course_curricula: links.map((row) => ({
      ...withoutId(row),
      course: ref('courses', row.course),
      entry: entryRef(row.entry),
    })),
    course_enrollment_rules: rules.map((row) => ({
      ...withoutId(row),
      academic_year: yearLabel.get(row.academic_year),
      course: ref('courses', row.course),
      source_id: ref(row.source_collection, row.source_id),
    })),
    course_equivalencies: equivalencies.map((row) => ({
      course: ref('courses', row.course),
      entry_2018: entryRef(row.entry_2018),
      entry_2023: entryRef(row.entry_2023),
      row: ref('course_equivalencies', row.id),
    })),
    curriculum_entries: entries.map((row) => ({
      ...withoutId(row),
      source_id: ref(row.source_collection, row.source_id),
    })),
    student_council: council.map((row) => ({
      member: ref('student_council', row.id),
      student: ref('students', row.student),
    })),
    teaching_assignments: assignments
      .filter((row) => row.source_collection !== null)
      .map((row) => ({
        ...withoutId(row),
        course: ref('courses', row.course),
        source_id: ref('teaching_assignments', row.source_id),
        staff: ref('staff', row.staff),
      })),
  };
};

const flowIds = async (target) => {
  const flows = await get(target, '/flows?fields=id&limit=-1');
  return new Set(flows.map(({ id }) => id));
};

// Everything a repeated setup must leave alone: Flows with their options,
// operations with their options and wiring, and every preset.
const studioSnapshot = async (target) => ({
  flows: await get(
    target,
    '/flows?fields=id,name,description,icon,status,trigger,accountability,options,operation&sort=id&limit=-1',
  ),
  operations: await get(
    target,
    '/operations?fields=id,flow,key,name,type,options,resolve,reject,position_x,position_y&sort=id&limit=-1',
  ),
  presets: await get(
    target,
    '/presets?fields=id,bookmark,collection,user,role,layout,layout_query,layout_options,icon,filter,search&sort=id&limit=-1',
  ),
});

const writeReceipt = async (directory, name, sourceFingerprint) => {
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
      version: 'backup-receipt-1',
    }),
  );
  return receiptPath;
};

// A dry-run into a private report, then an apply with a receipt taken
// against its fingerprint, as the upgrade runbook prescribes.
const upgrade = async (target, context, name) => {
  const { absent, directory } = context;
  const reportPath = path.join(directory, `${name}-report.json`);
  const dryRun = migrateCli(target, absent);
  assert.equal(
    await dryRun.run(['--dry-run', '--report', reportPath]),
    exitCodes.ok,
    dryRun.stderr.join('\n'),
  );
  const report = aggregateOnly(dryRun.stdout[0]);
  const receipt = await writeReceipt(
    directory,
    `${name}-receipt.json`,
    report.sourceFingerprint,
  );
  const apply = migrateCli(target, absent);
  assert.equal(
    await apply.run([
      '--apply',
      '--report',
      reportPath,
      '--backup-receipt',
      receipt,
    ]),
    exitCodes.ok,
    apply.stderr.join('\n'),
  );
  return { applied: aggregateOnly(apply.stdout[0]), report };
};

const badWorkbookAborts = async (target, context) => {
  const flowsBefore = await flowIds(target);
  const run = importCli(target, context.malformed);
  assert.equal(await run.run(), exitCodes.failed);
  assert.match(run.stderr.join('\n'), nothingSentPattern);
  assert.deepEqual(run.calls, [], 'Directus was never contacted');
  assert.deepEqual(await userCollections(target), [target.markerCollection]);
  assert.deepEqual(await flowIds(target), flowsBefore, 'no Flow was created');
};

const assertImported = async (target, context, summary) => {
  const { data } = context;
  assert.deepEqual(summary.rows, countMigrationData(data));
  assert.equal(summary.conversion.status, 'converted');
  assert.deepEqual(summary.conversion.steps, {
    completed: stepNames,
    skipped: [],
  });
  assert.equal(summary.rebuild.courses, data.courses.length);
  for (const [collection, rows] of Object.entries(summary.rows)) {
    assert.equal(await count(target, collection), rows);
  }
  assert.equal(await count(target, 'academic_years'), 15);
  assert.equal(await count(target, 'course_enrollment_rules'), 8 * 15);
  assert.equal(
    await count(target, 'curriculum_entries'),
    data.curriculum_2023.length + data.curriculum_2018.length,
  );
  assert.ok((await count(target, 'course_curricula')) > 0);
  const ledger = await list(target, ledgerCollection, ['step', 'status']);
  assert.deepEqual(
    ledger.map(({ status, step }) => [step, status]),
    stepNames.map((step) => [step, 'completed']),
  );
};

// The old derivation ran once over the imported rows: professors from the
// first assignment row or the override, council names from the students.
const assertRebuilt = async (target) => {
  const courses = await list(target, 'courses', ['name', 'professors']);
  const professors = new Map(courses.map((row) => [row.name, row.professors]));
  assert.equal(
    professors.get('Alpha Course'),
    'Prof. Zed Alpha, Prof. Abe Alpha',
  );
  assert.equal(professors.get('Beta Course'), 'Prof. Beta Override');
  const council = await list(target, 'student_council', [
    'index_number',
    'name',
  ]);
  assert.equal(
    council.find((row) => row.index_number === 'SYN-0002').name,
    'Synthetic Student Two',
  );
};

const assertPresets = async (target) => {
  const presets = await get(
    target,
    '/presets?fields=collection,bookmark,user,role&limit=-1',
  );
  const global = presets.filter(
    ({ role, user }) => user === null && role === null,
  );
  for (const spec of collectionSpecs) {
    assert.equal(
      global.filter(
        ({ bookmark, collection }) =>
          collection === spec.key && bookmark === null,
      ).length,
      1,
      `${spec.key} has one default view`,
    );
  }
  assert.equal(
    global.filter(({ bookmark }) => bookmark === searchBookmark.bookmark)
      .length,
    1,
  );
};

const importConverts = async (target, context) => {
  const run = importCli(target, context.workbook);
  assert.equal(await run.run(), exitCodes.ok, run.stderr.join('\n'));
  // On a fixture without the templates the import's setup has just
  // installed an active Process pending; this suite drives no domain.
  await pauseAutomaticProcessing(target);
  const summary = aggregateOnly(run.stdout[0]);
  await assertImported(target, context, summary);
  await assertRebuilt(target);
  await assertPresets(target);
  assert.deepEqual(
    run.calls
      .filter(({ pathname }) => pathname.startsWith('/flows/trigger/'))
      .map(({ pathname }) => pathname),
    [`/flows/trigger/${derivedDataFlowId}`],
    'the import rebuilds once and never publishes',
  );
  const normalized = await normalizedTargets(target);
  for (const [collection, rows] of Object.entries(normalized)) {
    assert.ok(rows.length > 0, `${collection} holds converted rows`);
  }
  assert.ok(
    !JSON.stringify(normalized).includes('missing '),
    'every reference resolves to an imported row',
  );
  return normalized;
};

const upgradeSeesConversionDone = async (target, context) => {
  const { applied, report } = await upgrade(target, context, 'after-import');
  assert.equal(report.migratable, true);
  assert.deepEqual(report.ledger.completed, stepNames);
  const ledger = await list(target, ledgerCollection, ['source_fingerprint']);
  assert.ok(
    ledger.every(
      ({ source_fingerprint }) =>
        source_fingerprint === report.sourceFingerprint,
    ),
    'the import recorded the fingerprint the upgrade reads',
  );
  assert.deepEqual(applied.steps, { completed: [], skipped: stepNames });
  assert.deepEqual(applied.written, {});
};

// Studio-style edits: a Flow option of the Rebuild Flow and of the Mark
// pending template, and the icon of the Search bookmark.
const editInStudio = async (target) => {
  for (const id of [derivedDataFlowId, markPendingFlowId]) {
    const [flow] = await get(
      target,
      `/flows?fields=id,options&filter[id][_eq]=${id}`,
    );
    await read(
      await request(
        target,
        `/flows/${id}`,
        json(
          'PATCH',
          { options: { ...flow.options, requireConfirmation: false } },
          target.token,
        ),
      ),
      200,
    );
  }
  const [search] = await get(
    target,
    '/presets?fields=id&filter[bookmark][_eq]=Search&limit=1',
  );
  await read(
    await request(
      target,
      `/presets/${search.id}`,
      json('PATCH', { icon: 'travel_explore' }, target.token),
    ),
    200,
  );
};

const setupPreservesStudioEdits = async (target, directus) => {
  await editInStudio(target);
  const before = await studioSnapshot(target);
  const recorder = recording(directus);
  const summary = await runSetup(recorder.request);
  assert.deepEqual(summary.flows, {
    created: [],
    skipped: setupFlows.map(({ name }) => name),
  });
  assert.deepEqual(summary.presets, { created: 0, skipped: 14 });
  assert.ok(
    recorder
      .mutations()
      .every(({ pathname }) => migrationEndpointPattern.test(pathname)),
    'the rerun only reapplies the bundled SQL migrations',
  );
  assert.deepEqual(await studioSnapshot(target), before);
  const [edited] = await get(
    target,
    `/flows?fields=options&filter[id][_eq]=${derivedDataFlowId}`,
  );
  assert.equal(edited.options.requireConfirmation, false);
};

const secondImportRefused = async (target, context) => {
  const counts = {};
  for (const collection of Object.keys(context.data)) {
    counts[collection] = await count(target, collection);
  }
  const run = importCli(target, context.workbook);
  assert.equal(await run.run(), exitCodes.refused);
  const message = run.stderr.join('\n');
  assert.ok(message.startsWith('Import refused: The project already holds'));
  assert.ok(message.includes(`courses ${String(counts.courses)}`));
  assert.ok(message.includes('npm run migrate'));
  assert.deepEqual(run.mutations(), [], 'no write reached Directus');
  for (const [collection, rows] of Object.entries(counts)) {
    assert.equal(await count(target, collection), rows);
  }
};

// The project the checkpoint importer left behind: its thirteen
// collections, table views and Search bookmark, holding the same workbook
// rows, with no relational collection.
const createCheckpointProject = async (target, data) => {
  for (const spec of collectionSpecs) {
    await read(
      await request(
        target,
        '/collections',
        json(
          'POST',
          {
            collection: spec.key,
            fields: spec.fields.map((field, index) => toApiField(field, index)),
            meta: {
              display_template: spec.displayTemplate,
              icon: spec.icon,
              note: spec.note,
              sort: spec.sort,
            },
            schema: {},
          },
          target.token,
        ),
      ),
      200,
    );
    await read(
      await request(
        target,
        '/presets',
        json('POST', checkpointPreset(spec).body, target.token),
      ),
      200,
    );
  }
  await read(
    await request(
      target,
      '/presets',
      json('POST', searchBookmark.body, target.token),
    ),
    200,
  );
  for (const spec of collectionSpecs) {
    const rows = data[spec.key];
    for (let start = 0; start < rows.length; start += 250) {
      await read(
        await request(
          target,
          `/items/${spec.key}`,
          json('POST', rows.slice(start, start + 250), target.token),
        ),
        200,
      );
    }
  }
};

const upgradeMatchesImport = async (target, directus, context) => {
  await destroyDataModel(target);
  assert.deepEqual(await userCollections(target), [target.markerCollection]);
  await createCheckpointProject(target, context.data);
  const setup = await runSetup(directus);
  await pauseAutomaticProcessing(target);
  assert.deepEqual(setup.presets, { created: 0, skipped: 14 });
  await assert.rejects(access(context.absent), 'the workbook is absent');
  const { applied, report } = await upgrade(target, context, 'old-schema');
  assert.equal(report.migratable, true);
  assert.deepEqual(report.ledger, { completed: [], failed: [], running: [] });
  assert.deepEqual(applied.steps, { completed: stepNames, skipped: [] });
  assert.deepEqual(
    await normalizedTargets(target),
    context.runs.get('imported'),
    'the upgrade reaches the relational rows the import reached',
  );
};

// `npm run setup` first, then the import: the empty schema setup creates
// holds no app record, and the import accepts it and reaches the
// relational rows of the import into the marker-only project. The Flows
// survived the teardown, so the import leaves them as they are.
const setupThenImport = async (target, directus, context) => {
  await destroyDataModel(target);
  assert.deepEqual(await userCollections(target), [target.markerCollection]);
  await runSetup(directus);
  await pauseAutomaticProcessing(target);
  assert.deepEqual(
    await countApplicationRecords(directus),
    {},
    'setup writes no application record',
  );
  const run = importCli(target, context.workbook);
  assert.equal(await run.run(), exitCodes.ok, run.stderr.join('\n'));
  const summary = aggregateOnly(run.stdout[0]);
  assert.deepEqual(summary.setup.presets, { created: 0, skipped: 14 });
  assert.deepEqual(summary.flows, {
    created: [],
    skipped: ['Rebuild derived data', 'Publish public assets'],
  });
  await assertImported(target, context, summary);
  await assertRebuilt(target);
  assert.deepEqual(
    await normalizedTargets(target),
    context.runs.get('imported'),
    'setup then import reaches the relational rows of the import alone',
  );
};

// The template Flows present on the fixture, with their options.
const templateFlows = async (target) => {
  const flows = await get(target, '/flows?fields=id,options&limit=-1');
  return new Map(
    flows
      .filter(({ id }) => templateFlowIds.has(id))
      .map(({ id, options }) => [id, options]),
  );
};

// Flows are not collections, so the model teardown keeps them: the run
// deletes the templates it created and restores the options of the ones
// that were there before and that it edited like Studio would.
const restoreFlows = async (target, before) => {
  const present = await templateFlows(target);
  for (const [id, options] of present) {
    if (!before.has(id)) {
      await read(
        await request(target, `/flows/${id}`, {
          method: 'DELETE',
          token: target.token,
        }),
        204,
      );
    } else if (!isDeepStrictEqual(options, before.get(id))) {
      await read(
        await request(
          target,
          `/flows/${id}`,
          json('PATCH', { options: before.get(id) }, target.token),
        ),
        200,
      );
    }
  }
  assert.deepEqual(
    await templateFlows(target),
    before,
    'the template Flows are as they were before the run',
  );
};

const scenarios = async (t, { context, directus, target }) => {
  await t.test('a malformed workbook aborts before Directus is contacted', () =>
    badWorkbookAborts(target, context),
  );
  await t.test(
    'an import into the marker-only project installs the model, converts through the ledger and rebuilds',
    async () => {
      context.runs.set('imported', await importConverts(target, context));
    },
  );
  await t.test(
    'the upgrade path finds the imported conversion complete and writes nothing',
    () => upgradeSeesConversionDone(target, context),
  );
  await t.test(
    'a repeated setup keeps Studio-edited Flows and presets untouched',
    () => setupPreservesStudioEdits(target, directus),
  );
  await t.test('a second import is refused before any write', () =>
    secondImportRefused(target, context),
  );
  await t.test(
    'an equivalent checkpoint project upgrades to the same relational rows without the workbook',
    () => upgradeMatchesImport(target, directus, context),
  );
  await t.test(
    'an import into the empty schema npm run setup created is accepted and reaches the same relational rows',
    () => setupThenImport(target, directus, context),
  );
};

test('separates fresh setup, the one-time workbook import and populated upgrades on the fixture', async (t) => {
  const target = targetFrom(process.env);
  const directus = adminRequest(target);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'relational-lifecycle-'),
  );
  const files = {
    absent: path.join(directory, 'absent.xlsx'),
    malformed: path.join(directory, 'malformed.xlsx'),
    workbook: path.join(directory, 'synthetic.xlsx'),
  };
  const runs = new Map();
  const flowsBefore = await templateFlows(target);
  try {
    await writeFile(path.join(directory, artifactName), artifactContent);
    const dataset = lifecycleDataset();
    await syntheticWorkbook(dataset).xlsx.writeFile(files.workbook);
    await syntheticWorkbook({
      ...dataset,
      staff: dataset.staff.map((row, index) =>
        index === 1 ? { ...row, active: 'maybe' } : row,
      ),
    }).xlsx.writeFile(files.malformed);
    const context = {
      ...files,
      data: await loadMigrationData(files.workbook),
      directory,
      runs,
    };
    await withDataModel(target, async () => {
      try {
        await scenarios(t, { context, directus, target });
      } finally {
        await t.test(
          'removes the Flows it created and restores the ones it edited',
          () => restoreFlows(target, flowsBefore),
        );
      }
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
  assert.ok(runs.has('imported'), 'every scenario ran');
});
