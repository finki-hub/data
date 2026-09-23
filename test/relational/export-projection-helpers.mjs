import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  fileKeys,
  readFileSources,
  serializeFile,
  validateFile,
} from '../../directus/extensions/directus-extension-data-operations/src/exports/engine.js';
import { snapshotFields } from '../../directus/extensions/directus-extension-data-operations/src/snapshot/contract.js';
import serializeAssets from '../../directus/flows/serialize-assets.cjs';
import { prepareAssetsFlowId } from '../../src/flows/prepare-public-assets.js';
import { validateReadinessFlowId } from '../../src/flows/validate-readiness.js';
import { runConversion } from '../../src/migrations/conversion.js';
import { readInventory } from '../../src/migrations/inventory.js';
import { preflight } from '../../src/migrations/preflight.js';
import { collectionKeys } from '../../src/schema.js';
import { json, request } from './data-model-helpers.mjs';
import { get, post } from './history-index-helpers.mjs';

// Seeding, the manual Flow calls and the test-side engine of the export
// projection fixture suite (export-projection.integration.mjs). Every row
// is invented.

const clockValue = '2026-09-23T12:00:00.000Z';

export const conversionSteps = [
  'preflight',
  'curricula',
  'rules',
  'assignments',
  'council',
  'equivalencies',
];

export const publicFiles = [
  'courses.json',
  'rooms.json',
  'staff.json',
  'students.json',
];

// POSTs a manual Flow on Data Operations like Studio's button and answers
// the status, the body and how long the call took.
export const runManual = async (target, id, { token } = {}) => {
  const started = performance.now();
  const response = await request(
    target,
    `/flows/trigger/${id}`,
    json('POST', { collection: 'data_operations' }, token ?? target.token),
  );
  const text = await response.text();
  return {
    body: text === '' ? null : JSON.parse(text),
    elapsedMs: Math.round(performance.now() - started),
    status: response.status,
  };
};

export const errorOf = (body) => ({
  code: body?.errors?.[0]?.extensions?.code ?? null,
  message: body?.errors?.[0]?.message ?? '',
});

// Data / Validate readiness, which must answer.
export const readiness = async (target, options) => {
  const run = await runManual(target, validateReadinessFlowId, options);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  return run.body;
};

// Publish / Prepare public assets: the answer, or the refusal.
export const prepare = (target, options) =>
  runManual(target, prepareAssetsFlowId, options);

const withoutId = (row) =>
  Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'id'));

// The checkpoint rows of a dataset, as the one-time workbook import writes
// them: every collection with the dataset ids except the assignment rows,
// whose sequence must stay ahead of the role rows the conversion appends.
export const seedCheckpoint = async (target, dataset) => {
  for (const collection of collectionKeys) {
    const rows =
      collection === 'teaching_assignments'
        ? dataset[collection].map((row) => withoutId(row))
        : dataset[collection];
    if (rows.length > 0) await post(target, `/items/${collection}`, rows);
  }
};

// The relational conversion the import runs, over the live rows.
export const convert = async (directus) => {
  const inventory = await readInventory(directus, {});
  const live = preflight(inventory, null);
  assert.deepEqual(live.blockers, [], 'the importable fixture converts');
  const { outcome } = await runConversion(
    directus,
    { inventory, live },
    {
      batchSize: 250,
      now: () => clockValue,
      resume: false,
      runToken: 'export-projection',
    },
  );
  assert.deepEqual(outcome.completed, conversionSteps);
};

// The legacy serializer over the live checkpoint rows, read the way the
// checkpoint Publish public assets Flow reads them.
export const legacyAssets = async (target) => {
  const rows = (collection) =>
    get(target, `/items/${collection}?fields=*&sort=id&limit=-1`);
  return serializeAssets({
    read_courses: await rows('courses'),
    read_rooms: await rows('rooms'),
    read_staff: await rows('staff'),
    read_students: await rows('students'),
  });
};

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// A read of the engine through the REST API as the administrator: the
// same collection, explicit fields, filter and sort the operation's
// ItemsService read uses, every row at once.
export const restReader = (target) => (read) => {
  const query = new URLSearchParams({
    fields: read.fields.join(','),
    limit: '-1',
    sort: read.sort.join(','),
  });
  if (read.filter !== undefined) {
    query.set('filter', JSON.stringify(read.filter));
  }
  return get(target, `/items/${read.collection}?${query.toString()}`);
};

// The files the export definitions produce over the live rows, built by
// the engine in this process: the content the prepare action digests.
export const engineFiles = async (definitions, reader) => {
  const files = [];
  for (const definition of definitions) {
    const sources = await readFileSources(definition, reader);
    files.push(
      validateFile(definition, serializeFile(definition, sources), {
        keys: fileKeys(definition, sources),
        rows: sources.rows.length,
      }),
    );
  }
  return files;
};

// The live Moodle users as snapshot CSV rows, in snapshotFields order.
export const snapshotRowsOf = async (target) => {
  const users = await get(
    target,
    `/items/moodle_users?fields=${snapshotFields.map((field) => encodeURIComponent(field)).join(',')}&sort=id&limit=-1`,
  );
  return users.map((user) => snapshotFields.map((field) => user[field]));
};
