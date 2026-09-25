import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { declaredFilenames } from '../directus/extensions/directus-extension-data-operations/src/coordination/outcomes.js';
import { processPendingFlowId } from '../src/flows/process-pending.js';
import { publishAssetsFlowId } from '../src/flows/publish-public-assets.js';
import { installedCounts } from './fixture-seed.mjs';
import {
  bucketStatus,
  deleteObject,
  listKeys,
  trigger,
} from './publish-flow-helpers.mjs';
import {
  objectsOf,
  publishPreconditions,
} from './publish-workflow-helpers.mjs';
import {
  dispatcherRuns,
  settle,
  wallClock,
} from './relational/automatic-processing-helpers.mjs';
import { readiness } from './relational/export-projection-helpers.mjs';
import { get, patch, status } from './relational/history-index-helpers.mjs';
import {
  appearanceOf,
  flowOf,
  localFilesOf,
  newYearCounts,
  presetOf,
  serverProjectOf,
} from './restore-project.mjs';

// What the restored project must show (restore.integration.mjs): a
// password sign-in, the branding and every uploaded file byte for byte,
// the Studio edits of the publish Flow and the bookmark, the source edit
// that was pending when the backup was taken (processed on the next tick
// of the schedule), and a publication of every declared file into a fresh
// bucket that equals the export recorded before the backup. Also the
// licence state read, the source project's identity row compared as
// digests, and the fresh bucket's lifecycle. Values are compared, never
// printed.

const logoFile = new URL('../directus/branding/logo.png', import.meta.url);

const call = (target, path, init = {}) =>
  fetch(new URL(path, target.base), {
    ...init,
    signal: AbortSignal.timeout(60_000),
  });

// The licence status and its source, as GET /license answers them.
export const licenceOf = async (target) => {
  const response = await call(target, '/license', {
    headers: { authorization: `Bearer ${target.token}` },
  });
  assert.equal(response.status, 200, 'GET /license');
  const { data } = await response.json();
  return { source: data.source, status: data.status };
};

// The settings row's project id and licence key as digests, with whether
// a key and a token are persisted. Compared in this process only.
export const identitySql =
  "SELECT md5(coalesce(project_id::text, '')), md5(coalesce(license_key, '')), license_key IS NOT NULL, license_token IS NOT NULL FROM directus_settings";

export const createBucket = async (s3, bucket) => {
  const response = await fetch(`${s3.endpoint}/${bucket}`, {
    method: 'PUT',
    signal: AbortSignal.timeout(15_000),
  });
  await response.text();
  assert.equal(response.status, 200, `create ${bucket}`);
  assert.deepEqual(await listKeys({ ...s3, bucket }), [], `${bucket} is new`);
};

// Removes a bucket the run created, its objects first; nothing when it is
// absent.
export const removeBucket = async (s3, bucket) => {
  const target = { ...s3, bucket };
  if ((await bucketStatus(target)) === 404) return 0;
  const keys = await listKeys(target);
  for (const key of keys) await deleteObject(target, key);
  const response = await fetch(`${s3.endpoint}/${bucket}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(15_000),
  });
  await response.text();
  assert.ok([200, 204].includes(response.status), `delete ${bucket}`);
  return keys.length;
};

export const logsIn = async ({ state, target }) => {
  const response = await call(target, '/auth/login', {
    body: JSON.stringify(state.login),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  const body = await response.json();
  assert.equal(response.status, 200, 'the password sign-in is accepted');
  const me = await call(target, '/users/me?fields=email', {
    headers: { authorization: `Bearer ${body.data.access_token}` },
  });
  assert.equal(me.status, 200);
  const { data } = await me.json();
  assert.equal(data.email, state.login.email);
};

export const showsBranding = async ({ state, t, target }) => {
  const appearance = await appearanceOf(target);
  assert.deepEqual(appearance, state.before.appearance);
  assert.deepEqual(await serverProjectOf(target), state.before.project);
  const files = await localFilesOf(target);
  assert.deepEqual(files, state.before.files);
  const logo = createHash('sha256')
    .update(await readFile(logoFile))
    .digest('hex');
  assert.equal(files[appearance.project_logo]?.sha256, logo);
  t.diagnostic(
    `branding and ${Object.keys(files).length} local files served byte for byte`,
  );
};

export const keepsCustomizations = async ({ state, target }) => {
  assert.deepEqual(
    await flowOf(target, publishAssetsFlowId),
    state.before.flow,
  );
  assert.deepEqual(await presetOf(target, state.presetId), state.before.preset);
};

// The pending edit survived the backup; resuming the schedule counts it on
// the next tick, in one dispatcher run, exactly as the oracle; every other
// count stays as recorded.
export const processesPendingEdit = async ({ state, t, target }) => {
  const [schedule] = await get(
    target,
    `/flows?fields=status&filter[id][_eq]=${processPendingFlowId}`,
  );
  assert.equal(schedule.status, 'inactive', 'restored as it was backed up');
  const report = await status(target);
  assert.equal(report.claim, null);
  assert.equal(report.domains.enrollments.current, false);
  assert.deepEqual(report.revisions, state.pending.revisions);
  const since = wallClock();
  await patch(target, `/flows/${processPendingFlowId}`, { status: 'active' });
  const settled = await settle(target, { limitMs: 60_000 });
  assert.equal(await dispatcherRuns(target, since, 1), 1, 'one count run');
  const installed = await installedCounts(target, state.seeded);
  const expected = new Map([
    ...Object.entries(state.before.counts),
    ...newYearCounts(state),
  ]);
  const keys = new Set([...installed.keys(), ...expected.keys()]);
  const differing = [...keys].filter(
    (key) => installed.get(key) !== expected.get(key),
  ).length;
  assert.equal(differing, 0, 'pairs differ from the oracle and the record');
  t.diagnostic(
    `the pending edit was counted ${settled.elapsedMs} ms after the schedule resumed`,
  );
};

// Readiness passes and the Studio-edited publish Flow uploads every
// declared file into the fresh bucket, each equal to the recorded export.
export const publishesUnchanged = async ({ restoreS3, state, t, target }) => {
  await publishPreconditions(target, restoreS3);
  const answer = await readiness(target);
  assert.equal(answer.ready, true, JSON.stringify(answer.blockers));
  const run = await trigger(target, publishAssetsFlowId);
  assert.equal(run.status, 200, JSON.stringify(run.body).slice(0, 1_500));
  assert.equal(run.body.published, true);
  const objects = await objectsOf(restoreS3);
  for (const filename of declaredFilenames) {
    const object = objects[filename];
    const recorded = state.before.export[filename];
    assert.ok(object && recorded, `${filename} is published and recorded`);
    assert.equal(object.contentType, 'application/json', filename);
    assert.deepEqual(JSON.parse(object.body), recorded.parsed, filename);
    assert.equal(object.sha256, recorded.sha256, filename);
  }
  t.diagnostic(
    `published ${declaredFilenames.length} declared files equal to the recorded export`,
  );
};
