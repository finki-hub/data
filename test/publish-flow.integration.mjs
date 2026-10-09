import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { declarationOf } from '../directus/extensions/directus-extension-data-operations/src/coordination/collection-roles.js';
import { declaredFilenames } from '../directus/extensions/directus-extension-data-operations/src/coordination/outcomes.js';
import { exportDefinitions } from '../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { prepareAssetsFlowId } from '../src/flows/prepare-public-assets.js';
import {
  publishAssetsFlowId,
  publishFlows,
} from '../src/flows/publish-public-assets.js';
import { runSetup } from '../src/setup.js';
import { asData, expectedData } from './expected-exports.js';
import { assertMarkerPresent, targetFrom } from './isolated-target.mjs';
import {
  bucketStatus,
  deleteObject,
  errorOf,
  installProbe,
  listKeys,
  probeChildId,
  probeParentId,
  probeRuns,
  proveCanary,
  readObject,
  readOnlyBucket,
  trigger,
  verifyPublishLocation,
} from './publish-flow-helpers.mjs';
import { parityDataset } from './relational-export-helpers.js';
import {
  removeFlow,
  settle,
  wallClock,
} from './relational/automatic-processing-helpers.mjs';
import {
  adminRequest,
  pauseAutomaticProcessing,
  userCollections,
  withDataModel,
  withRestrictedUser,
} from './relational/data-model-helpers.mjs';
import { seedDataset } from './relational/export-projection-helpers.mjs';
import {
  collator,
  get,
  patch,
  post,
  remove,
  status,
} from './relational/history-index-helpers.mjs';
import { s3TargetFrom } from './s3-target.js';

// `npm run test:s3`: the relational publish Flows against an explicit
// disposable S3 target (s3-target.ts refuses anything else), over the
// synthetic parity dataset. Before anything is uploaded it proves that the
// Directus publish location writes to that target (its settings, then a
// canary read back through the loopback endpoint). Every row is invented;
// the suite removes the files it published and the objects it created,
// and tears the model down.

// The files in registry order: the injected failures hit the second
// upload, and each file's own source collection changes its object.
const [first = '', second = ''] = declaredFilenames;
const collectionOf = (filename) =>
  exportDefinitions.find((definition) => definition.filename === filename)?.rows
    .collection ?? '';
const except = (filename) =>
  declaredFilenames.filter((key) => key !== filename);
const storage = 'publish';
const waitMs = 5_000;
const byText = (left, right) => collator.compare(left, right);
const nothingToResume = () => Promise.resolve();
const withoutProfessor = /course_without_professor/u;

// The digests Publish / Prepare public assets answers for the current rows.
const prepared = async (target) => {
  const run = await trigger(target, prepareAssetsFlowId);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  return Object.fromEntries(
    run.body.files.map(({ filename, sha256: digest }) => [filename, digest]),
  );
};

const objects = async (s3) =>
  Object.fromEntries(
    await Promise.all(
      declaredFilenames.map(async (key) => [key, await readObject(s3, key)]),
    ),
  );

const digests = (current) =>
  Object.fromEntries(
    Object.entries(current).map(([key, object]) => [key, object?.sha256]),
  );

const publishedFiles = (target) =>
  get(
    target,
    `/files?fields=id,filename_disk,type,storage,filesize&filter[storage][_eq]=${storage}&limit=-1&sort=filename_disk`,
  );

const outcomesOf = (report) =>
  Object.fromEntries(
    Object.entries(report.publication.files ?? {}).map(([key, entry]) => [
      key,
      [entry.outcome, entry.code],
    ]),
  );

// One line of the outcome table: what the trigger answered, and the
// publication status the coordinator reports after it.
const observed = async ({ label, run, t, target }) => {
  const report = await status(target);
  const refusal = errorOf(run.body);
  t.diagnostic(
    `outcome ${JSON.stringify({
      code: refusal.code,
      files: outcomesOf(report),
      http: run.status,
      label,
      lastError: report.lastError?.code ?? null,
      pending: report.pending,
      revisions: {
        claimed: Object.values(report.publication.files ?? {})[0]?.revision,
        completed: report.revisions.completed,
        source: report.revisions.source,
      },
      state: report.publication.state,
    })}`,
  );
  return report;
};

const uploadedEverywhere = Object.fromEntries(
  declaredFilenames.map((key) => [key, ['uploaded', null]]),
);

// Every declared object is served as application/json and its
// directus_files row says so, after a replacement too (FilesService writes
// a temp object and copies it over the old one).
const assertJsonTyped = async (current, target) => {
  for (const key of declaredFilenames) {
    assert.equal(current[key]?.contentType, 'application/json', key);
  }
  const files = await publishedFiles(target);
  assert.deepEqual(
    files.map(({ filename_disk, type }) => [filename_disk, type]),
    declaredFilenames.toSorted(byText).map((key) => [key, 'application/json']),
  );
};

// S3 dates have a resolution of one second: a rewrite is visible only a
// second later.
const nextSecond = () => sleep(1_100);

// Whether an edit of the collection marks a calculation as well as
// publication (a course: every course is counted).
const marksCalculation = (collection) =>
  (declarationOf(collection)?.invalidates ?? []).some(
    (domain) => domain !== 'publication',
  );

// Renames the first row of a collection by a suffix; answers the new name.
// An edit that marks the counts waits for them, so publication is the only
// pending domain.
const rename = async (target, { collection, suffix }) => {
  const [row] = await get(
    target,
    `/items/${collection}?fields=id,name&sort=id&limit=1`,
  );
  await patch(target, `/items/${collection}/${row.id}`, {
    name: `${row.name} ${suffix}`,
  });
  if (marksCalculation(collection)) await settle(target);
  return `${row.name} ${suffix}`;
};

const installsTemplates = async ({ directus, target }) => {
  const summary = await runSetup(directus);
  const listed = new Set([...summary.flows.created, ...summary.flows.skipped]);
  for (const flow of publishFlows) {
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
      `/operations?fields=id,key,type,options,resolve,reject&filter[flow][_eq]=${flow.id}&limit=-1`,
    );
    assert.deepEqual(
      operations.toSorted((left, right) => byText(left.id, right.id)),
      flow.operations
        .map(({ id, key, options, reject, resolve, type }) => ({
          id,
          key,
          options,
          reject,
          resolve,
          type,
        }))
        .toSorted((left, right) => byText(left.id, right.id)),
    );
  }
  // A second setup keeps them as they are.
  const again = await runSetup(directus);
  for (const flow of publishFlows) {
    assert.ok(again.flows.skipped.includes(flow.name), flow.name);
  }
};

const seeds = async ({ directus, t, target }) => {
  await seedDataset(directus, parityDataset());
  const settled = await settle(target, { limitMs: 180_000 });
  t.diagnostic(`parity dataset settled after ${settled.elapsedMs} ms`);
};

const refusesStrangers = async ({ s3, t, target }) => {
  const anonymous = await fetch(
    new URL(`/flows/trigger/${publishAssetsFlowId}`, target.base),
    {
      body: JSON.stringify({ collection: 'data_operations' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
    },
  );
  await anonymous.text();
  assert.equal(anonymous.status, 403);
  // A signed-in user who cannot read data_operations: Directus refuses
  // the trigger itself.
  await withRestrictedUser(target, async (token) => {
    const run = await trigger(target, publishAssetsFlowId, token);
    assert.equal(run.status, 403, JSON.stringify(run.body));
    assert.equal(errorOf(run.body).code, 'FORBIDDEN', JSON.stringify(run.body));
  });
  t.diagnostic(`anonymous ${anonymous.status}; restricted user 403 FORBIDDEN`);
  const keys = await listKeys(s3);
  assert.deepEqual(
    declaredFilenames.filter((key) => keys.includes(key)),
    [],
  );
};

const creates = async ({ s3, state, t, target }) => {
  const expected = await prepared(target);
  const run = await trigger(target, publishAssetsFlowId);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.published, true);
  const report = await observed({ label: 'create', run, t, target });
  assert.equal(run.body.revision, report.revisions.source);
  // The JSON contract: the objects hold exactly the committed parity data
  // (test/fixtures/expected-exports/parity).
  const committed = await expectedData('parity');
  const current = await objects(s3);
  for (const key of declaredFilenames) {
    const object = current[key];
    assert.ok(object, key);
    assert.equal(object.contentType, 'application/json', key);
    assert.equal(object.sha256, expected[key], key);
    const file = key.replace('.json', '');
    assert.deepEqual(
      asData(file, JSON.parse(object.body)),
      committed[file],
      key,
    );
  }
  const files = await publishedFiles(target);
  assert.deepEqual(
    files.map(({ filename_disk, type }) => [filename_disk, type]),
    declaredFilenames.toSorted(byText).map((key) => [key, 'application/json']),
  );
  assert.equal(report.publication.state, 'completed');
  assert.deepEqual(outcomesOf(report), uploadedEverywhere);
  for (const entry of Object.values(report.publication.files)) {
    assert.equal(entry.revision, run.body.revision);
  }
  assert.equal(report.revisions.completed, run.body.revision);
  assert.ok(!report.pending.includes('publication'));
  state.objects = current;
  state.fileIds = files.map(({ id }) => id);
  t.diagnostic(`created ${JSON.stringify(digests(current))}`);
};

const keepsContentType = async ({ s3, target }) => {
  for (const key of declaredFilenames) {
    const response = await fetch(`${s3.endpoint}/${s3.bucket}/${key}`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, 200, key);
    assert.equal(response.headers.get('content-type'), 'application/json');
  }
  const files = await publishedFiles(target);
  assert.ok(files.every(({ type }) => type === 'application/json'));
};

// An Active course without a professor blocks courses.json, so the
// publish Flow refuses before any upload.
const refusesWhileBlocked = async ({ s3, state, t, target }) => {
  const course = await post(target, '/items/courses', {
    name: 'Synthetic Course Without Professor',
    pattern_mappings: [],
  });
  try {
    await settle(target);
    const run = await trigger(target, publishAssetsFlowId);
    assert.equal(run.status, 409, JSON.stringify(run.body));
    assert.equal(errorOf(run.body).code, 'PUBLICATION_NOT_PREPARED');
    assert.match(errorOf(run.body).message, withoutProfessor);
    t.diagnostic(`refusal: ${errorOf(run.body).message}`);
    const report = await observed({
      label: 'readiness blocker',
      run,
      t,
      target,
    });
    assert.equal(report.publication.state, 'failed');
    assert.equal(report.lastError.code, 'PREPARATION_REFUSED');
    assert.deepEqual(outcomesOf(report), uploadedEverywhere);
    assert.deepEqual(digests(await objects(s3)), digests(state.objects));
    const after = await objects(s3);
    for (const key of declaredFilenames) {
      assert.equal(after[key]?.lastModified, state.objects[key].lastModified);
    }
  } finally {
    await remove(target, `/items/courses/${course.data.id}`);
  }
  await settle(target);
};

const overwrites = async ({ s3, state, t, target }) => {
  const renamed = await rename(target, {
    collection: collectionOf(second),
    suffix: 'Overwritten',
  });
  await nextSecond();
  const run = await trigger(target, publishAssetsFlowId);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  await observed({ label: 'overwrite', run, t, target });
  const current = await objects(s3);
  for (const key of declaredFilenames) {
    assert.notEqual(
      current[key].lastModified,
      state.objects[key].lastModified,
      `${key} was rewritten`,
    );
  }
  assert.ok(current[second].body.includes(renamed));
  assert.notEqual(current[second].sha256, state.objects[second].sha256);
  for (const key of except(second)) {
    assert.equal(current[key].sha256, state.objects[key].sha256, key);
  }
  const files = await publishedFiles(target);
  assert.deepEqual(
    files.map(({ id }) => id),
    state.fileIds,
    'the files keep their ids',
  );
  state.objects = current;
  await assertJsonTyped(current, target);
};

// Every source file changes, then the second upload in registry order
// meets a read-only bucket folder: every other file is still uploaded.
const survivesSecondFailure = async ({ s3, state, t, target }) => {
  for (const { rows } of exportDefinitions) {
    await rename(target, { collection: rows.collection, suffix: 'Partial' });
  }
  const expected = await prepared(target);
  const before = await status(target);
  await installProbe(target, declaredFilenames.slice(1, 3), waitMs);
  const installed = await status(target);
  assert.equal(
    installed.fingerprints.current.calculation,
    before.fingerprints.current.calculation,
    'a publish Flow is no calculation Flow',
  );
  assert.notEqual(
    installed.fingerprints.current.publication,
    before.fingerprints.current.publication,
  );
  await nextSecond();
  const since = wallClock();
  const running = trigger(target, probeParentId);
  let restore = nothingToResume;
  let midway;
  try {
    await probeRuns(target, since, 1);
    midway = await status(target);
    restore = await readOnlyBucket(s3);
    await probeRuns(target, since, 2);
  } finally {
    await restore();
  }
  // The first file's outcome was recorded as soon as it was uploaded,
  // before the run's end; the files not reached yet keep an earlier run's.
  assert.equal(midway.publication.state, 'running');
  assert.equal(midway.publication.files[first].outcome, 'uploaded');
  assert.equal(midway.publication.files[first].revision, midway.claim.revision);
  assert.ok(midway.publication.files[second].revision < midway.claim.revision);
  t.diagnostic(
    `midway: ${JSON.stringify({ claim: midway.claim.revision, files: midway.publication.files })}`,
  );
  const run = await running;
  assert.equal(run.status, 502, JSON.stringify(run.body));
  const refusal = errorOf(run.body);
  assert.equal(refusal.code, 'PUBLICATION_PARTIAL');
  assert.ok(
    refusal.message.includes(`${second} (PUBLISH_UPLOAD_FAILED)`),
    refusal.message,
  );
  t.diagnostic(`partial: ${refusal.message}`);
  const current = await objects(s3);
  for (const key of except(second)) {
    assert.equal(current[key].sha256, expected[key], `${key} is new`);
  }
  assert.equal(current[second].sha256, state.objects[second].sha256);
  assert.notEqual(expected[second], state.objects[second].sha256);
  const report = await observed({
    label: 'second upload fails',
    run,
    t,
    target,
  });
  assert.equal(report.publication.state, 'partial');
  assert.deepEqual(outcomesOf(report), {
    ...uploadedEverywhere,
    [second]: ['failed', 'PUBLISH_UPLOAD_FAILED'],
  });
  assert.equal(report.lastError.code, 'PUBLICATION_PARTIAL');
  assert.equal(report.revisions.completed, before.revisions.completed);
  assert.ok(report.pending.includes('publication'));
  await removeFlow(target, probeParentId);
  await removeFlow(target, probeChildId);
};

const convergesOnRetry = async ({ s3, t, target }) => {
  const run = await trigger(target, publishAssetsFlowId);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const expected = await prepared(target);
  const current = await objects(s3);
  assert.deepEqual(digests(current), expected);
  await assertJsonTyped(current, target);
  const report = await observed({
    label: 'explicit retry',
    run,
    t,
    target,
  });
  assert.equal(report.publication.state, 'completed');
  assert.deepEqual(outcomesOf(report), uploadedEverywhere);
  assert.equal(report.revisions.completed, run.body.revision);
  assert.ok(!report.pending.includes('publication'));
};

const failsEveryUpload = async ({ s3, t, target }) => {
  await rename(target, {
    collection: collectionOf(first),
    suffix: 'Unreachable',
  });
  const before = digests(await objects(s3));
  const restore = await readOnlyBucket(s3);
  let run;
  try {
    run = await trigger(target, publishAssetsFlowId);
  } finally {
    await restore();
  }
  assert.equal(run.status, 502, JSON.stringify(run.body));
  assert.equal(errorOf(run.body).code, 'PUBLICATION_FAILED');
  const report = await observed({
    label: 'every upload fails',
    run,
    t,
    target,
  });
  assert.equal(report.publication.state, 'failed');
  assert.deepEqual(
    outcomesOf(report),
    Object.fromEntries(
      declaredFilenames.map((key) => [
        key,
        ['failed', 'PUBLISH_UPLOAD_FAILED'],
      ]),
    ),
  );
  assert.deepEqual(digests(await objects(s3)), before);
  const retried = await trigger(target, publishAssetsFlowId);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.deepEqual(digests(await objects(s3)), await prepared(target));
  await observed({
    label: 'retry after every upload failed',
    run: retried,
    t,
    target,
  });
};

// A source edit commits while the probe waits before the second upload:
// every file is uploaded from the prepared revision, which is recorded as
// published (the snapshot the files hold), and the newer revision stays
// pending until the next publication.
const leavesNewerRevisionPending = async ({ s3, t, target }) => {
  await rename(target, { collection: collectionOf(first), suffix: 'Prepared' });
  const expected = await prepared(target);
  await installProbe(target, [second], waitMs);
  const since = wallClock();
  const running = trigger(target, probeParentId);
  await probeRuns(target, since, 1);
  const renamed = await rename(target, {
    collection: collectionOf(second),
    suffix: 'During',
  });
  const run = await running;
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.published, true);
  const report = await observed({
    label: 'source edit during upload',
    run,
    t,
    target,
  });
  const claimRevision = run.body.revision;
  assert.equal(report.publication.state, 'completed');
  assert.equal(report.revisions.completed, claimRevision);
  assert.equal(run.body.pendingRevision, report.revisions.source);
  assert.ok(report.revisions.source > claimRevision);
  assert.ok(report.pending.includes('publication'));
  assert.deepEqual(outcomesOf(report), uploadedEverywhere);
  for (const entry of Object.values(report.publication.files)) {
    assert.equal(entry.revision, claimRevision);
  }
  const current = await objects(s3);
  assert.deepEqual(digests(current), expected);
  assert.ok(!current[second].body.includes(renamed));
  t.diagnostic(
    `published ${claimRevision}, source now ${report.revisions.source} (pending)`,
  );
  await removeFlow(target, probeParentId);
  await removeFlow(target, probeChildId);
  const retried = await trigger(target, publishAssetsFlowId);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.pendingRevision, null);
  const republished = await readObject(s3, second);
  assert.ok(republished?.body.includes(renamed));
  await assertJsonTyped(await objects(s3), target);
  const settled = await observed({
    label: 'retry after the edit',
    run: retried,
    t,
    target,
  });
  assert.equal(settled.publication.state, 'completed');
  assert.equal(settled.revisions.completed, settled.revisions.source);
};

const cleansUp = async ({ keysBefore, s3, target }) => {
  await removeFlow(target, probeParentId);
  await removeFlow(target, probeChildId);
  const files = await publishedFiles(target);
  for (const { id } of files) await remove(target, `/files/${id}`);
  const keys = await listKeys(s3);
  for (const key of keys) {
    if (!keysBefore.has(key)) await deleteObject(s3, key);
  }
  assert.deepEqual(await publishedFiles(target), []);
};

test('publishes every declared file to the S3 target with one outcome per file', async (t) => {
  const target = targetFrom(process.env);
  const s3 = s3TargetFrom(process.env);
  // Nothing is uploaded before the Directus publish location is shown to
  // write to the synthetic bucket.
  const location = await verifyPublishLocation(target, s3);
  t.diagnostic(`publish location ${JSON.stringify(location)}`);
  assert.equal(await bucketStatus(s3), 200, 'the synthetic bucket exists');
  assert.deepEqual(
    await publishedFiles(target),
    [],
    'no file is in the publish location before the run: the cleanup removes only what the run created',
  );
  const canary = await proveCanary(target, s3);
  t.diagnostic(
    `canary ${canary} written through the publish location, read back from the bucket and removed`,
  );
  const keysBefore = new Set(await listKeys(s3));
  assert.deepEqual(
    declaredFilenames.filter((key) => keysBefore.has(key)),
    [],
    'no declared object is in the bucket before the run',
  );
  const directus = adminRequest(target);
  const state = {};
  const context = { directus, keysBefore, s3, state, t, target };
  let resume = nothingToResume;
  await withDataModel(
    target,
    async () => {
      try {
        await t.test(
          'installs the publish Flows once, exactly as defined',
          () => installsTemplates(context),
        );
        await t.test('seeds and settles the synthetic parity dataset', () =>
          seeds(context),
        );
        await t.test('refuses anonymous and restricted callers', () =>
          refusesStrangers(context),
        );
        await t.test(
          'creates every declared object with its JSON contract',
          () => creates(context),
        );
        await t.test('stores every object as application/json', () =>
          keepsContentType(context),
        );
        await t.test(
          'refuses before any upload while readiness has a blocker',
          () => refusesWhileBlocked(context),
        );
        await t.test('overwrites every object under stable file ids', () =>
          overwrites(context),
        );
        await t.test(
          'uploads the other files after the second upload fails, and records partial',
          () => survivesSecondFailure(context),
        );
        await t.test('converges on an explicit retry', () =>
          convergesOnRetry(context),
        );
        await t.test('records failed when every upload fails', () =>
          failsEveryUpload(context),
        );
        await t.test('leaves a revision edited during the upload pending', () =>
          leavesNewerRevisionPending(context),
        );
      } finally {
        await t.test(
          'removes the probe Flows, the published files and their objects',
          async () => {
            try {
              await cleansUp(context);
            } finally {
              resume = await pauseAutomaticProcessing(target);
            }
          },
        );
      }
    },
    { automatic: true },
  );
  await resume();
  await assertMarkerPresent(target);
  assert.deepEqual(await userCollections(target), [target.markerCollection]);
});
