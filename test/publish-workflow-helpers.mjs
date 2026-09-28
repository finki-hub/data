import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { declaredFilenames } from '../directus/extensions/directus-extension-data-operations/src/coordination/outcomes.js';
import { exportDefinitions } from '../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { keySources } from '../directus/extensions/directus-extension-data-operations/src/exports/key-sources.js';
import { fingerprintOf } from '../directus/extensions/directus-extension-data-operations/src/snapshot/fingerprint.js';
import { publishAssetsFlowId } from '../src/flows/publish-public-assets.js';
import { snapshotFolder } from '../src/flows/snapshot-folder.js';
import { countDifferences, installedCounts } from './fixture-seed.mjs';
import { expectedFiles } from './fixtures/stress-fixture.js';
import { expectedCounts } from './fixtures/stress-oracle.js';
import { writeStressCsv } from './fixtures/stress-snapshot.js';
import {
  bucketStatus,
  deleteObject,
  listKeys,
  proveCanary,
  readObject,
  trigger,
  verifyPublishLocation,
} from './publish-flow-helpers.mjs';
import {
  settle,
  waitForStatus,
} from './relational/automatic-processing-helpers.mjs';
import {
  engineFiles,
  restReader,
} from './relational/export-projection-helpers.mjs';
import { get, patch, remove } from './relational/history-index-helpers.mjs';
import {
  runImport,
  snapshotPath,
  uploadCsv,
} from './relational/snapshot-import-helpers.mjs';

// Shared steps of the complete workflow suite (publish-workflow
// .integration.mjs): the snapshot import through the installed Flow, the
// manual publication, the published objects against the export registry
// and the oracle, and the check that a failure left the active snapshot
// and every published object as they were. Counts and digests only; no
// row is printed.

export const codeOf = (body) => body?.errors?.[0]?.extensions?.code ?? null;

// The active snapshot as the import report states it.
export const snapshotState = async (target) => {
  const report = await get(target, snapshotPath);
  return {
    active: report.active,
    matches: report.activeMatchesPromotion,
    promoted: report.promoted,
  };
};

// Every declared object as S3 serves it.
export const objectsOf = async (s3) =>
  Object.fromEntries(
    await Promise.all(
      declaredFilenames.map(async (key) => [key, await readObject(s3, key)]),
    ),
  );

export const digestsOf = (objects) =>
  Object.fromEntries(
    Object.entries(objects).map(([key, object]) => [key, object?.sha256]),
  );

// The active snapshot and every published object are exactly as the last
// accepted step left them (same bytes, not rewritten).
export const assertIntact = async ({ s3, state, target }, label) => {
  assert.deepEqual(
    await snapshotState(target),
    state.snapshot,
    `${label}: the active snapshot changed`,
  );
  const objects = await objectsOf(s3);
  for (const key of declaredFilenames) {
    assert.equal(
      objects[key]?.sha256,
      state.objects[key]?.sha256,
      `${label}: ${key} changed`,
    );
    assert.equal(
      objects[key]?.lastModified,
      state.objects[key]?.lastModified,
      `${label}: ${key} was rewritten`,
    );
  }
};

// The installed counts equal the oracle's for the current rules and
// mappings (compared pair by pair, reported as a number of differences).
export const assertCounts = async ({ state, target }, label) => {
  const expected = expectedCounts(state.snapshotRows, {
    mappings: state.mappings,
    rules: state.rules,
  });
  const installed = await installedCounts(target, state.seeded);
  assert.equal(installed.size, expected.size, `${label}: count rows`);
  assert.equal(
    countDifferences(expected, installed),
    0,
    `${label}: pairs differ from the oracle`,
  );
  return installed;
};

// Writes the generated rows as a CSV (optionally with raw lines),
// uploads it into the private folder and answers its file id.
export const uploadSnapshot = async (
  { declarations, state, target },
  { name, raw },
) => {
  const file = path.join(state.dir, `${name}.csv`);
  await writeStressCsv(file, {
    fields: declarations.snapshot.fields,
    raw,
    rows: state.snapshotRows.rows,
  });
  return uploadCsv(target, { file, state, title: `synthetic-${name}` });
};

// Imports an uploaded CSV through "Data / Import Moodle snapshot" and
// checks that the promoted snapshot holds exactly the generated values.
export const importsSnapshot = async (context, file) => {
  const { state, target } = context;
  const run = await runImport(target, { confirm_replace: true, file });
  assert.equal(run.status, 200, JSON.stringify(run.body).slice(0, 1_500));
  assert.equal(run.body.state, 'completed');
  assert.equal(run.body.rows, state.snapshotRows.rows.length);
  assert.equal(run.body.fingerprint, fingerprintOf(state.snapshotRows.rows));
  const report = await snapshotState(target);
  assert.deepEqual(report.active, {
    fingerprint: run.body.fingerprint,
    rows: state.snapshotRows.rows.length,
  });
  assert.equal(report.matches, true);
  return run.body;
};

// The files the engine prepares over the live rows, parsed by filename.
export const liveFiles = async (target) => {
  const files = await engineFiles(exportDefinitions, restReader(target));
  return Object.fromEntries(
    files.map(({ body, filename, sha256 }) => [
      filename,
      { parsed: JSON.parse(body), sha256 },
    ]),
  );
};

// The key rows the created rows place, read through each key source's
// own declared read.
export const keyRowsOf = async (target) => {
  const reader = restReader(target);
  const entries = await Promise.all(
    Object.entries(keySources).map(async ([name, source]) => [
      name,
      await reader(source),
    ]),
  );
  return Object.fromEntries(entries);
};

// The published objects follow the registry: one object per declared
// file, served as application/json, each the engine's output over the
// live rows, and every row keeps the declared keys in declared order.
const assertPublished = async ({ s3, target }) => {
  const objects = await objectsOf(s3);
  const live = await liveFiles(target);
  const expected = expectedFiles(exportDefinitions, await keyRowsOf(target));
  assert.deepEqual(
    expected.map(({ filename }) => filename),
    declaredFilenames,
  );
  for (const { filename, keys } of expected) {
    const object = objects[filename];
    assert.ok(object, `${filename} is published`);
    assert.equal(object.contentType, 'application/json', filename);
    assert.equal(object.sha256, live[filename]?.sha256, filename);
    for (const row of JSON.parse(object.body)) {
      const positions = Object.keys(row).map((key) => keys.indexOf(key));
      assert.ok(
        positions.every(
          (position, index) =>
            position >= 0 && (index === 0 || position > positions[index - 1]),
        ),
        `${filename}: a row carries an undeclared key or breaks the order`,
      );
    }
  }
  return objects;
};

// Runs the installed "Publish / Public assets" Flow and, when it
// published, records the objects as the new accepted state.
export const publishes = async (context) => {
  const run = await trigger(context.target, publishAssetsFlowId);
  assert.equal(run.status, 200, JSON.stringify(run.body).slice(0, 1_500));
  assert.equal(run.body.published, true);
  const objects = await assertPublished(context);
  Object.assign(context.state, { objects });
  return run.body;
};

// A publication refused before any upload, once no run holds the claim:
// either the claim is refused (PUBLICATION_NOT_CLAIMED, with its reason:
// nothing pending, or upstream calculations not current) or readiness
// blocks the preparation (PUBLICATION_NOT_PREPARED, naming the blocker).
// Nothing is rewritten. Answers the refusal's message.
export const refusedPublication = async (context, { code, label, reason }) => {
  await waitForStatus(context.target, (report) => report.claim === null);
  const run = await trigger(context.target, publishAssetsFlowId);
  assert.equal(run.status, 409, `${label}: ${JSON.stringify(run.body)}`);
  assert.equal(codeOf(run.body), code, `${label}: ${JSON.stringify(run.body)}`);
  const message = run.body.errors[0].message;
  assert.ok(message.includes(reason), `${label}: ${message}`);
  await assertIntact(context, label);
  return message;
};

// The parsed courses.json rows of the current objects.
export const publishedRows = (objects, filename) =>
  JSON.parse(objects[filename]?.body ?? '[]');

// Settles both calculations and checks the counts against the oracle.
export const settlesCounted = async (context, label) => {
  const settled = await settle(context.target, { limitMs: 300_000 });
  await assertCounts(context, label);
  return settled;
};

// The files of the private snapshot folder (uploads and backups).
export const snapshotFiles = async (target) => {
  const rows = await get(
    target,
    `/files?fields=id&limit=-1&filter[folder][_eq]=${snapshotFolder.id}`,
  );
  return rows.map(({ id }) => id);
};

// The files of the Directus publish location.
const publishFiles = async (target) => {
  const rows = await get(
    target,
    '/files?fields=id&limit=-1&filter[storage][_eq]=publish',
  );
  return rows.map(({ id }) => id);
};

// Checked before a run writes to the publish location, so that its cleanup
// removes only what the run created: the Directus container that serves
// the target writes to the synthetic bucket (verifyPublishLocation), the
// bucket exists, no file is in the publish location (deleting a file there
// deletes its object too), a canary written through the location lands in
// the bucket, and no declared object is there yet. Answers what was
// verified and the keys the bucket held before the run.
export const publishPreconditions = async (target, s3) => {
  const location = await verifyPublishLocation(target, s3);
  assert.equal(await bucketStatus(s3), 200, 'the synthetic bucket exists');
  assert.deepEqual(
    await publishFiles(target),
    [],
    'no file is in the publish location before the run: the cleanup removes only what the run created',
  );
  await proveCanary(target, s3);
  const keysBefore = new Set(await listKeys(s3));
  assert.deepEqual(
    declaredFilenames.filter((key) => keysBefore.has(key)),
    [],
    'no declared object is in the bucket before the run',
  );
  return { keysBefore, location };
};

// Removes what the run created: the publish-location files (none was there
// before, publishPreconditions) with their objects, any other object the
// bucket did not hold before, every file the run added to the private
// snapshot folder (uploads and backups) and its temporary directory.
export const removeRunFiles = async ({ s3, state, target }) => {
  const published = await publishFiles(target);
  for (const id of published) await remove(target, `/files/${id}`);
  const keys = await listKeys(s3);
  for (const key of keys) {
    if (!state.keysBefore.has(key)) await deleteObject(s3, key);
  }
  const files = await snapshotFiles(target);
  for (const id of files) {
    if (!state.filesBefore.has(id)) await remove(target, `/files/${id}`);
  }
  await rm(state.dir, { force: true, recursive: true });
};

// Runs `attempt` (which answers whether it reached the state it needs,
// for example a run still holding its claim when an edit lands) up to
// `limit` times; fails unless one attempt reached it. Answers that
// attempt's result and its number.
export const untilObserved = async (label, attempt, limit = 3) => {
  for (let number = 1; number <= limit; number += 1) {
    const result = await attempt(number);
    if (result.observed) return { ...result, attempts: number };
  }
  return assert.fail(`${label}: not observed in ${limit} attempts`);
};

// The rule of a pair (course and year positions) in oracle form, with its
// id.
export const ruleOf = async ({ state, target }, { course, year }) => {
  const [row] = await get(
    target,
    `/items/course_enrollment_rules?fields=id,pattern&filter[course][_eq]=${state.seeded.courses[course].id}&filter[academic_year][_eq]=${state.seeded.years[year].id}`,
  );
  const rule = state.rules.find(
    (entry) => entry.course === course && entry.year === year,
  );
  assert.ok(row !== undefined && rule !== undefined, 'the rule exists');
  return { id: row.id, rule };
};

// Changes the pattern of a rule, in the database and in the oracle.
export const setPattern = async (context, pair, pattern) => {
  const { id, rule } = await ruleOf(context, pair);
  await patch(context.target, `/items/course_enrollment_rules/${id}`, {
    pattern,
  });
  context.state.rules = context.state.rules.map((entry) =>
    entry === rule ? { ...rule, pattern } : entry,
  );
};
