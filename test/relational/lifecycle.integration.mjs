import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import { findModelCollection } from '../../src/data-model/collections.js';
import { presetDefinitions } from '../../src/data-model/presentation/presets.js';
import { createDirectusRequest } from '../../src/directus-request.js';
import { markPendingFlowId } from '../../src/flows/mark-pending.js';
import { flowFamilies } from '../../src/flows/registry.js';
import { runImportCli } from '../../src/import-run.js';
import { countApplicationRecords } from '../../src/import-state.js';
import { planImport } from '../../src/import/plan.js';
import { exitCodes } from '../../src/lifecycle.js';
import { runSetup } from '../../src/setup.js';
import { loadWorkbook } from '../../src/workbook.js';
import { syntheticWorkbook } from '../fixtures/synthetic-workbook.js';
import { assertMarkerPresent, targetFrom } from '../isolated-target.mjs';
import { flowTemplates } from '../registry-test-helpers.js';
import { parityDataset } from '../relational-export-helpers.js';
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

// Every Flow setup installs: the registered families, in install order.
const setupFlows = flowTemplates();
const templateFlowIds = new Set(setupFlows.map(({ id }) => id));
const forbiddenOnStdout = ['Alpha', 'SYN-', '@', 'Synthetic', 'SENTINEL'];
const malformedPattern =
  /^Import failed: Кадар \(Export\) row 3, column "active": invalid boolean "maybe"$/u;
const migrationEndpointPattern = /^\/finki-hub-data-operations\/migrations\//u;

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

const environment = (target, workbookPath) => ({
  DIRECTUS_TOKEN: target.token,
  DIRECTUS_URL: target.base.href,
  WORKBOOK_PATH: workbookPath,
});

// The import CLI over the real request, recording every request it issues.
const importCli = (target, workbookPath) => {
  const calls = [];
  const stdout = [];
  const stderr = [];
  const io = {
    createRequest: (config) => {
      const real = createDirectusRequest(config);
      return (pathname, init) => {
        calls.push({ method: init?.method ?? 'GET', pathname });
        return real(pathname, init);
      };
    },
    stderr: (line) => {
      stderr.push(line);
    },
    stdout: (line) => {
      stdout.push(line);
    },
  };
  return {
    calls,
    mutations: () => calls.filter(({ method }) => method !== 'GET'),
    run: () => runImportCli([], environment(target, workbookPath), io),
    stderr,
    stdout,
  };
};

const aggregateOnly = (line) => {
  for (const forbidden of forbiddenOnStdout) {
    assert.ok(!line.includes(forbidden), `stdout must not carry ${forbidden}`);
  }
  return JSON.parse(line);
};

// The rows of every collection the import writes, each reference replaced
// by the position of the row it names in its collection: two imports hand
// out different ids, so only this normalised form can be compared.
const normalizedTargets = async (target, collections) => {
  const rows = {};
  const positions = {};
  for (const collection of collections) {
    const { fields } = findModelCollection(collection);
    rows[collection] = await list(target, collection, [
      'id',
      ...fields.map(({ field }) => field),
    ]);
    positions[collection] = new Map(
      rows[collection].map(({ id }, index) => [id, index + 1]),
    );
  }
  const position = (related, id) =>
    id === null ? null : (positions[related]?.get(id) ?? `missing ${id}`);
  return Object.fromEntries(
    collections.map((collection) => {
      const { fields } = findModelCollection(collection);
      return [
        collection,
        rows[collection].map((row) =>
          Object.fromEntries(
            fields.map(({ field, kind, related }) => [
              field,
              kind === 'm2o' ? position(related, row[field]) : row[field],
            ]),
          ),
        ),
      ];
    }),
  );
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

const badWorkbookAborts = async (target, context) => {
  const flowsBefore = await flowIds(target);
  const run = importCli(target, context.malformed);
  assert.equal(await run.run(), exitCodes.failed);
  assert.match(run.stderr.join('\n'), malformedPattern);
  assert.deepEqual(run.calls, [], 'Directus was never contacted');
  assert.deepEqual(await userCollections(target), [target.markerCollection]);
  assert.deepEqual(await flowIds(target), flowsBefore, 'no Flow was created');
};

// A workbook with a case the import cannot write as it states it (2018
// credits of a course without a 2018 name): the import refuses it before
// Directus is contacted, explaining it by course, sheet and row.
const blockedWorkbookRefused = async (target, context) => {
  const run = importCli(target, context.blocked);
  assert.equal(await run.run(), exitCodes.blocked);
  assert.deepEqual(run.calls, [], 'Directus was never contacted');
  assert.deepEqual(aggregateOnly(run.stdout[0]).blockers, {
    unlinked_generation_values: 1,
  });
  assert.deepEqual(run.stderr.slice(1), [
    '- [unlinked_generation_values] Предмети (Export) row 4 «Gamma Course»: 2018 name empty; 2018 credits 6',
  ]);
  assert.deepEqual(await userCollections(target), [target.markerCollection]);
};

const assertImported = async (target, context, summary) => {
  assert.deepEqual(summary.rows, context.planned);
  assert.deepEqual(summary.blockers, {});
  for (const [collection, rows] of Object.entries(summary.rows)) {
    assert.equal(await count(target, collection), rows, collection);
  }
  assert.equal(await count(target, 'academic_years'), 15);
  assert.equal(await count(target, 'course_enrollment_rules'), 8 * 15);
  assert.equal(
    await count(target, 'curriculum_entries'),
    context.data.curriculum_2023.length + context.data.curriculum_2018.length,
  );
  assert.ok((await count(target, 'course_curricula')) > 0);
};

// Every shared preset the presentation declares exists once: the default
// views, the bookmarks and Search.
const assertPresets = async (target) => {
  const presets = await get(
    target,
    '/presets?fields=collection,bookmark,user,role&limit=-1',
  );
  const global = presets.filter(
    ({ role, user }) => user === null && role === null,
  );
  for (const { bookmark, collection } of presetDefinitions) {
    assert.equal(
      global.filter(
        (preset) =>
          preset.collection === collection && preset.bookmark === bookmark,
      ).length,
      1,
      `${collection} ${bookmark ?? 'default view'} exists once`,
    );
  }
};

const importWrites = async (target, context) => {
  const run = importCli(target, context.workbook);
  assert.equal(await run.run(), exitCodes.ok, run.stderr.join('\n'));
  // On a fixture without the templates the import's setup has just
  // installed an active Process pending; this suite drives no domain.
  await pauseAutomaticProcessing(target);
  const summary = aggregateOnly(run.stdout[0]);
  await assertImported(target, context, summary);
  await assertPresets(target);
  assert.deepEqual(
    run.calls.filter(({ pathname }) => pathname.startsWith('/flows/trigger/')),
    [],
    'the import runs no Flow and never publishes',
  );
  const normalized = await normalizedTargets(
    target,
    Object.keys(context.planned),
  );
  for (const [collection, rows] of Object.entries(normalized)) {
    assert.equal(rows.length, context.planned[collection], collection);
  }
  assert.ok(
    !JSON.stringify(normalized).includes('missing '),
    'every reference resolves to an imported row',
  );
  return normalized;
};

// Studio-style edits: a Flow option of the Mark pending template and the
// icon of the Search bookmark.
const editInStudio = async (target) => {
  const [flow] = await get(
    target,
    `/flows?fields=id,options&filter[id][_eq]=${markPendingFlowId}`,
  );
  await read(
    await request(
      target,
      `/flows/${markPendingFlowId}`,
      json(
        'PATCH',
        { options: { ...flow.options, requireConfirmation: false } },
        target.token,
      ),
    ),
    200,
  );
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
  const { created, families, skipped } = summary.flows;
  assert.deepEqual(
    { created, skipped },
    { created: [], skipped: setupFlows.map(({ name }) => name) },
  );
  assert.deepEqual(
    families.map(({ code, created: none }) => [code, none]),
    flowFamilies.map(({ code }) => [code, []]),
  );
  assert.equal(summary.fields.aligned, 0);
  assert.deepEqual(summary.presentation.presets, {
    adopted: 0,
    created: 0,
    skipped: presetDefinitions.length,
  });
  assert.ok(
    recorder
      .mutations()
      .every(({ pathname }) => migrationEndpointPattern.test(pathname)),
    'the rerun only reapplies the bundled SQL migrations',
  );
  assert.deepEqual(await studioSnapshot(target), before);
  const [edited] = await get(
    target,
    `/flows?fields=options&filter[id][_eq]=${markPendingFlowId}`,
  );
  assert.equal(edited.options.requireConfirmation, false);
};

const secondImportRefused = async (target, context) => {
  const counts = {};
  for (const collection of Object.keys(context.planned)) {
    counts[collection] = await count(target, collection);
  }
  const run = importCli(target, context.workbook);
  assert.equal(await run.run(), exitCodes.refused);
  const message = run.stderr.join('\n');
  assert.ok(message.startsWith('Import refused: project not empty: '));
  assert.ok(message.includes(`courses ${String(counts.courses)}`));
  assert.ok(!message.includes('migrate'));
  assert.deepEqual(run.mutations(), [], 'no write reached Directus');
  for (const [collection, rows] of Object.entries(counts)) {
    assert.equal(await count(target, collection), rows);
  }
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
  assert.deepEqual(summary.setup.presentation.presets, {
    adopted: 0,
    created: 0,
    skipped: presetDefinitions.length,
  });
  await assertImported(target, context, summary);
  assert.deepEqual(
    await normalizedTargets(target, Object.keys(context.planned)),
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
    'a workbook with cases the import cannot write is refused before Directus is contacted',
    () => blockedWorkbookRefused(target, context),
  );
  await t.test(
    'an import into the marker-only project installs the model and writes the relational rows',
    async () => {
      context.runs.set('imported', await importWrites(target, context));
    },
  );
  await t.test(
    'a repeated setup keeps Studio-edited Flows and presets untouched',
    () => setupPreservesStudioEdits(target, directus),
  );
  await t.test('a second import is refused before any write', () =>
    secondImportRefused(target, context),
  );
  await t.test(
    'an import into the empty schema npm run setup created is accepted and reaches the same relational rows',
    () => setupThenImport(target, directus, context),
  );
};

test('separates fresh setup and the one-time workbook import on the fixture', async (t) => {
  const target = targetFrom(process.env);
  await assertMarkerPresent(target);
  const directus = adminRequest(target);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'relational-lifecycle-'),
  );
  const files = {
    blocked: path.join(directory, 'blocked.xlsx'),
    malformed: path.join(directory, 'malformed.xlsx'),
    workbook: path.join(directory, 'synthetic.xlsx'),
  };
  const runs = new Map();
  const flowsBefore = await templateFlows(target);
  try {
    const dataset = parityDataset();
    await syntheticWorkbook(dataset).xlsx.writeFile(files.workbook);
    await syntheticWorkbook({
      ...dataset,
      courses: dataset.courses.map((row) =>
        row.name === 'Gamma Course' ? { ...row, credits_2018: 6 } : row,
      ),
    }).xlsx.writeFile(files.blocked);
    await syntheticWorkbook({
      ...dataset,
      staff: dataset.staff.map((row, index) =>
        index === 1 ? { ...row, active: 'maybe' } : row,
      ),
    }).xlsx.writeFile(files.malformed);
    const content = await loadWorkbook(files.workbook);
    const context = {
      ...files,
      data: content.data,
      planned: Object.fromEntries(
        planImport(content).collections.map(({ collection, rows }) => [
          collection,
          rows.length,
        ]),
      ),
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
