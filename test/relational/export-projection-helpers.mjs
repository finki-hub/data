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
import { prepareAssetsFlowId } from '../../src/flows/prepare-public-assets.js';
import { validateReadinessFlowId } from '../../src/flows/validate-readiness.js';
import { writePlan } from '../../src/import/write.js';
import { planOf } from '../import-plan-helpers.js';
import { json, request } from './data-model-helpers.mjs';
import { get } from './history-index-helpers.mjs';

// Seeding, the manual Flow calls and the test-side engine of the export
// projection fixture suite (export-projection.integration.mjs), shared by
// the publication suite (test/publish-flow.integration.mjs). Every row is
// invented.

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

// The relational rows of a dataset, written as the one-time workbook
// import writes them: the plan of its workbook rows in dependency order,
// every reference resolved through the ids Directus answered. Answers the
// rows Directus confirmed.
export const seedDataset = async (directus, dataset) => {
  const plan = planOf(dataset);
  assert.deepEqual(plan.blockers, [], 'the import accepts the dataset');
  assert.deepEqual(plan.unstorable, [], 'every value fits its column');
  let confirmed = 0;
  await writePlan(directus, plan.collections, {
    batchSize: 250,
    confirmed: (rows) => {
      confirmed += rows;
    },
  });
  return confirmed;
};

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// A read of the engine through the REST API with the fixture token: the
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
