import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { declaredFilenames as publicFiles } from '../../directus/extensions/directus-extension-data-operations/src/coordination/outcomes.js';
import { exportDefinitions } from '../../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { publicationFlows } from '../../src/flows/prepare-public-assets.js';
import { snapshotFolder } from '../../src/flows/snapshot-folder.js';
import { runSetup } from '../../src/setup.js';
import { expectedFiles } from '../expected-exports.js';
import { privateSentinels } from '../fixtures/synthetic-data.js';
import { assertMarkerPresent, targetFrom } from '../isolated-target.mjs';
import { parityDataset } from '../relational-export-helpers.js';
import {
  settle,
  withOperationsReader,
} from './automatic-processing-helpers.mjs';
import {
  adminRequest,
  pauseAutomaticProcessing,
  userCollections,
  withDataModel,
} from './data-model-helpers.mjs';
import { measureEngine, seedRealistic } from './export-measure.mjs';
import {
  engineFiles,
  errorOf,
  prepare,
  readiness,
  restReader,
  runManual,
  seedDataset,
  sha256,
  snapshotRowsOf,
} from './export-projection-helpers.mjs';
import { get, patch, post, remove, status } from './history-index-helpers.mjs';
import {
  backupTitlePrefix,
  csvHeader,
  runImport,
  uploadCsv,
  writeSnapshot,
} from './snapshot-import-helpers.mjs';

const nothingToResume = () => Promise.resolve();
const collator = new Intl.Collator('en');
const theta = 'Theta Course';
const recordText = /Synthetic|Prof\.|Asst\.|Course|@/u;
const pendingCounts = /history_index_pending 1, enrollments_pending 1/u;
const movedRevision = /source revision \d+, now \d+/u;

const isReady = async (target) => {
  const answer = await readiness(target);
  return answer.ready;
};

const assertBounded = (answer) => {
  const text = JSON.stringify(answer);
  assert.doesNotMatch(text, recordText, 'the answer names a record');
  for (const sentinel of privateSentinels) assert.ok(!text.includes(sentinel));
};

const refused = async (target, code) => {
  const run = await prepare(target);
  assert.equal(run.status, 409, JSON.stringify(run.body));
  assert.equal(errorOf(run.body).code, code);
  return errorOf(run.body).message;
};

const prepared = async (target) => {
  const run = await prepare(target);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assertBounded(run.body);
  return { ...run.body, elapsedMs: run.elapsedMs };
};

const digestOf = (answer, filename) =>
  answer.files.find((file) => file.filename === filename);

// Setup installs the two thin publication Flows exactly as defined.
const installsTemplates = async ({ directus, target }) => {
  const summary = await runSetup(directus);
  const listed = new Set([...summary.flows.created, ...summary.flows.skipped]);
  for (const flow of publicationFlows) {
    assert.ok(listed.has(flow.name), flow.name);
    const live = await get(
      target,
      `/flows/${flow.id}?fields=status,trigger,accountability,operation,options`,
    );
    assert.deepEqual(live, {
      accountability: 'activity',
      operation: flow.entry,
      options: flow.options,
      status: 'active',
      trigger: flow.trigger,
    });
    const operations = await get(
      target,
      `/operations?fields=id,key,type,options,resolve,reject&filter[flow][_eq]=${flow.id}&limit=-1&sort=id`,
    );
    assert.deepEqual(
      operations,
      flow.operations
        .map(({ id, key, options, reject, resolve, type }) => ({
          id,
          key,
          options,
          reject,
          resolve,
          type,
        }))
        .toSorted((left, right) => collator.compare(left.id, right.id)),
    );
  }
  await settle(target);
};

const preparesEmptyFiles = async ({ target }) => {
  const answer = await readiness(target);
  assert.equal(answer.ready, true, JSON.stringify(answer));
  const files = await prepared(target);
  assert.deepEqual(
    files.files,
    publicFiles.map((filename) => ({
      bytes: 2,
      filename,
      rows: 0,
      sha256: sha256('[]'),
    })),
  );
};

// The importable synthetic fixture written as the one-time workbook
// import writes it, then counted by the schedule on its own.
const seedsAndCounts = async ({ directus, t, target }) => {
  await seedDataset(directus, parityDataset());
  const settled = await settle(target, { limitMs: 180_000 });
  t.diagnostic(`seeded fixture settled after ${settled.elapsedMs} ms`);
};

const preparesCommittedFiles = async ({ state, t, target }) => {
  const report = await status(target);
  const answer = await readiness(target);
  assertBounded(answer);
  assert.equal(answer.ready, true, JSON.stringify(answer));
  assert.equal(answer.revision, report.revisions.source);
  t.diagnostic(`readiness ${JSON.stringify(answer)}`);
  const files = await prepared(target);
  assert.equal(files.revision, report.revisions.source);
  t.diagnostic(`prepared in ${files.elapsedMs} ms: ${JSON.stringify(files)}`);
  const expected = await expectedFiles('parity');
  for (const filename of publicFiles) {
    const { body, sha256: digest } = expected[filename.replace('.json', '')];
    assert.deepEqual(digestOf(files, filename), {
      bytes: Buffer.byteLength(body, 'utf8'),
      filename,
      rows: JSON.parse(body).length,
      sha256: digest,
    });
    for (const sentinel of privateSentinels)
      assert.ok(!body.includes(sentinel));
  }
  // The same engine in this process over the same rows read through REST
  // answers the same bytes: the digests name exactly this content.
  const local = await engineFiles(exportDefinitions, restReader(target));
  assert.deepEqual(
    local.map(({ filename, sha256: digest }) => ({ digest, filename })),
    files.files.map(({ filename, sha256: digest }) => ({ digest, filename })),
  );
  state.local = local;
};

// A reader of data_operations may press the buttons; both answer 403.
const refusesNonAdministrators = async ({ target }) => {
  await withOperationsReader(target, async (token) => {
    for (const flow of publicationFlows) {
      const run = await runManual(target, flow.id, { token });
      assert.equal(run.status, 403, JSON.stringify(run.body));
      assert.equal(errorOf(run.body).code, 'FORBIDDEN');
    }
  });
};

const blocksPendingCounts = async ({ target }) => {
  const resume = await pauseAutomaticProcessing(target);
  try {
    await post(target, '/items/moodle_users', {
      Courses: 'Synthetic Unmapped Line-2071/2072',
      'Courses Count': 1,
      Name: 'Synthetic Pending User',
    });
    const answer = await readiness(target);
    assert.equal(answer.ready, false);
    assert.deepEqual(answer.blockers, [
      'history_index_pending',
      'enrollments_pending',
    ]);
    const message = await refused(target, 'EXPORT_NOT_READY');
    assert.match(message, pendingCounts);
  } finally {
    await resume();
  }
  await settle(target);
  assert.equal(await isReady(target), true);
};

const blocksFailedImport = async ({ state, target }) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'export-projection-'));
  state.directories.push(directory);
  // A snapshot whose header lacks its last field: the import refuses it.
  const broken = path.join(directory, 'broken.csv');
  const header = csvHeader.trimEnd().split(',').slice(0, -1).join(',');
  await writeFile(broken, `${header}\n`, 'utf8');
  const badId = await uploadCsv(target, {
    file: broken,
    state,
    title: 'synthetic-export-bad-header',
  });
  const failed = await runImport(target, {
    confirm_replace: true,
    file: badId,
  });
  assert.notEqual(failed.status, 200, JSON.stringify(failed.body));
  const answer = await readiness(target);
  assert.deepEqual(answer.blockers, ['snapshot_import_failed']);
  await refused(target, 'EXPORT_NOT_READY');
  const good = path.join(directory, 'users.csv');
  await writeSnapshot(good, await snapshotRowsOf(target));
  const goodId = await uploadCsv(target, {
    file: good,
    state,
    title: 'synthetic-export-users',
  });
  const replaced = await runImport(target, {
    confirm_replace: true,
    file: goodId,
  });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  await settle(target);
  const after = await readiness(target);
  assert.equal(after.ready, true, JSON.stringify(after));
  assert.ok(!after.warnings.includes('snapshot_never_promoted'));
};

const followsRenames = async ({ state, target }) => {
  const [staff] = await get(
    target,
    `/items/staff?fields=id&filter[name][_eq]=${encodeURIComponent('Prof. Theta')}`,
  );
  await patch(target, `/items/staff/${staff.id}`, {
    name: 'Prof. Theta Renamed',
  });
  const [entry] = await get(
    target,
    '/items/curriculum_entries?fields=id&filter[code][_eq]=SYN23-007',
  );
  await patch(target, `/items/curriculum_entries/${entry.id}`, {
    code: 'SYN23-007-R',
  });
  assert.equal(await isReady(target), true, 'no recalculation');
  const files = await prepared(target);
  const local = await engineFiles(exportDefinitions, restReader(target));
  const [courses] = local;
  assert.equal(digestOf(files, 'courses.json').sha256, courses.sha256);
  assert.notEqual(courses.sha256, state.local[0].sha256);
  const rows = JSON.parse(courses.body);
  const before = JSON.parse(state.local[0].body);
  const renamed = rows.find((row) => row.name === theta);
  assert.equal(renamed.professors, 'Prof. Theta Renamed');
  assert.equal(renamed['2023-code'], 'SYN23-007-R');
  assert.deepEqual(
    rows.filter((row) => row.name !== theta),
    before.filter((row) => row.name !== theta),
  );
  // The staff member's own row changes staff.json too; rooms and students
  // do not change.
  const staffRows = JSON.parse(local[2].body);
  assert.ok(staffRows.some((row) => row.name === 'Prof. Theta Renamed'));
  assert.notEqual(local[2].sha256, state.local[2].sha256);
  for (const index of [1, 3]) {
    assert.equal(local[index].sha256, state.local[index].sha256);
  }
  assert.deepEqual(
    local.map(({ sha256: digest }) => digest),
    files.files.map(({ sha256: digest }) => digest),
  );
};

const measures = async ({ state, t, target }) => {
  const seeded = await seedRealistic(target);
  t.diagnostic(`seeded ${JSON.stringify(seeded)}`);
  const settled = await settle(target, { limitMs: 900_000, pollMs: 2_000 });
  t.diagnostic(`realistic dataset counted after ${settled.elapsedMs} ms`);
  const answer = await readiness(target);
  assert.equal(answer.ready, true, JSON.stringify(answer));
  const runs = [];
  for (let run = 0; run < 3; run += 1) runs.push(await prepared(target));
  const engine = await measureEngine(exportDefinitions, restReader(target));
  const [first] = runs;
  assert.deepEqual(
    Object.fromEntries(first.files.map((file) => [file.filename, file.sha256])),
    engine.sha256,
  );
  state.measurement = {
    engine,
    prepare: runs.map(({ durationMs, elapsedMs }) => ({
      durationMs,
      elapsedMs,
    })),
    readiness: answer.issueCounts,
    rows: Object.fromEntries(
      first.files.map((file) => [file.filename, file.rows]),
    ),
    seeded,
    settledMs: settled.elapsedMs,
  };
  t.diagnostic(`measurement ${JSON.stringify(state.measurement)}`);
};

// Room edits land every 40 ms while the realistic files are prepared: the
// source revision moves between the first status read and the second.
const refusesUnstable = async ({ target }) => {
  const [room] = await get(target, '/items/rooms?fields=id&sort=id&limit=1');
  const editing = { edits: 0, running: true };
  const editor = (async () => {
    while (editing.running) {
      editing.edits += 1;
      await patch(target, `/items/rooms/${room.id}`, {
        description: `Synthetic touched room ${editing.edits}`,
      });
      await sleep(40);
    }
  })();
  let message;
  try {
    await sleep(100);
    message = await refused(target, 'EXPORT_UNSTABLE_PREPARATION');
  } finally {
    editing.running = false;
    await editor;
  }
  assert.match(message, movedRevision);
  assert.ok(editing.edits > 1);
};

const cleansUp = async ({ state, target }) => {
  const backups = await get(
    target,
    `/files?fields=id&filter[folder][_eq]=${snapshotFolder.id}&filter[title][_starts_with]=${backupTitlePrefix}&limit=-1`,
  );
  for (const id of [...state.files, ...backups.map((file) => file.id)]) {
    await remove(target, `/files/${id}`);
  }
  for (const directory of state.directories) {
    await rm(directory, { force: true, recursive: true });
  }
  assert.deepEqual(
    await get(
      target,
      `/files?fields=id&filter[folder][_eq]=${snapshotFolder.id}&limit=-1`,
    ),
    [],
  );
};

test('projects relational data into the existing public assets', async (t) => {
  const target = targetFrom(process.env);
  const directus = adminRequest(target);
  const state = {
    directories: [],
    files: [],
    local: null,
    measurement: null,
  };
  const context = { directus, state, t, target };
  let resume = nothingToResume;
  await withDataModel(
    target,
    async () => {
      try {
        await t.test('installs the publication templates as defined', () =>
          installsTemplates(context),
        );
        await t.test(
          'prepares every declared file empty for an empty project',
          () => preparesEmptyFiles(context),
        );
        await t.test('seeds and counts the synthetic fixture', () =>
          seedsAndCounts(context),
        );
        await t.test(
          'is ready and prepares exactly the committed parity files',
          () => preparesCommittedFiles(context),
        );
        await t.test('lets administrators only check and prepare', () =>
          refusesNonAdministrators(context),
        );
        await t.test('refuses before any file while counts are pending', () =>
          blocksPendingCounts(context),
        );
        await t.test('refuses after a failed snapshot import', () =>
          blocksFailedImport(context),
        );
        await t.test('publishes renames without any rebuild', () =>
          followsRenames(context),
        );
        await t.test('measures the preparation on a realistic dataset', () =>
          measures(context),
        );
        await t.test('refuses a preparation the source changed under', () =>
          refusesUnstable(context),
        );
      } finally {
        await t.test('removes its files and directories', async () => {
          try {
            await cleansUp(context);
          } finally {
            resume = await pauseAutomaticProcessing(target);
          }
        });
      }
    },
    { automatic: true },
  );
  await resume();
  await assertMarkerPresent(target);
  assert.deepEqual(await userCollections(target), [target.markerCollection]);
});
