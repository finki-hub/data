import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  collectionDeclarations,
  declarationOf,
  guardedDeclarations,
  sourceDeclarations,
} from '../../directus/extensions/directus-extension-data-operations/src/coordination/collection-roles.js';
import { guardMessage } from '../../directus/extensions/directus-extension-data-operations/src/coordination/write-guards.js';
import { sourceInvalidation } from '../../directus/extensions/directus-extension-data-operations/src/migrations.js';
import { dataModelCollectionKeys } from '../../src/data-model/collections.js';
import {
  applySchemaConstraints,
  applySourceInvalidation,
} from '../../src/data-model/constraints.js';
import { installDataModel } from '../../src/data-model/install.js';
import { assertMarkerPresent, targetFrom } from '../isolated-target.mjs';
import { databaseContainer, psql } from './automatic-processing-helpers.mjs';
import {
  adminRequest,
  errorCode,
  json,
  request,
  userCollections,
  withDataModel,
} from './data-model-helpers.mjs';
import {
  count,
  get,
  patch,
  post,
  remove,
  trigger,
} from './history-index-helpers.mjs';

// Task 24: the collection-role registry on the fixture. The generated
// source-invalidation migration applies twice with the same triggers, one
// edit of each source class marks exactly its declared domains, and the
// derived and candidate tables refuse direct writes through Directus and
// in the database. Every row is invented and removed again.

const guarded = 'COORDINATION_WRITE_GUARDED';
const refusalPattern = /; only .+ writes it\. /u;
const probeFlowId = '9e4d826c-5b1a-4c0e-8f2d-000000002401';
const probeOperationId = '9e4d826c-5b1a-4c0e-8f2d-000000002402';
const statusRow =
  '/items/data_operations?fields=source_revision,dirty_domains,history_index_input_revision,enrollments_input_revision';
const needsDatabase =
  databaseContainer === undefined
    ? 'DIRECTUS_AUTOMATIC_DATABASE_CONTAINER is not set'
    : false;
const collator = new Intl.Collator('en');
const sorted = (values) => values.toSorted((a, b) => collator.compare(a, b));

// One representative insert per source class, keyed by collection. A
// source class is a distinct set of declared domains and refinements; a
// class without a representative fails the scenario, so a new kind of
// source names its payload here.
const payloads = {
  academic_years: { label: '2091/2092', sort: 1 },
  courses: { name: 'Synthetic Roles Course' },
  moodle_course_entries: { label: 'Synthetic Roles Entry' },
  moodle_users: { Name: 'Synthetic Roles User' },
};

const signature = ({ columns = {}, invalidates, onDelete = [] }) =>
  JSON.stringify({ columns, invalidates, onDelete });

// What a statement marks according to the registry.
const expectedMarks = (declaration, operation, column = null) => [
  ...declaration.invalidates,
  ...(operation === 'delete' ? (declaration.onDelete ?? []) : []),
  ...(column === null ? [] : (declaration.columns?.[column]?.domains ?? [])),
];

const statusOf = (target) => get(target, statusRow);

// Diagnostics of a subtest: counts, codes and revisions only.
const logOf = (step) => (message) => {
  step.diagnostic(message);
};

const domainOrder = ['history_index', 'enrollments', 'publication'];
const moved = (after, before) => (after ?? -1) > (before ?? -1);

// Asserts an edit marked exactly `marks`: the source revision moved, a
// calculation's input revision moved with its own or an upstream domain
// only, and the dirty set gained the marked domains (exactly them while it
// was empty). An edit may run the trigger function more than once: a
// refined column fires its own trigger, a delete the triggers of cascaded
// source tables.
const assertMarked = async (target, { before, label, log, marks }) => {
  const after = await statusOf(target);
  log?.(
    `${label}: revision ${before.source_revision} -> ${after.source_revision}, inputs history ${after.history_index_input_revision} enrollments ${after.enrollments_input_revision}, dirty [${after.dirty_domains.join(', ')}], expected [${marks.join(', ')}]`,
  );
  assert.ok(after.source_revision > before.source_revision, label);
  assert.equal(
    moved(
      after.history_index_input_revision,
      before.history_index_input_revision,
    ),
    marks.includes('history_index'),
    `${label}: history index input`,
  );
  assert.equal(
    moved(after.enrollments_input_revision, before.enrollments_input_revision),
    marks.includes('history_index') || marks.includes('enrollments'),
    `${label}: enrollment input`,
  );
  if ((before.dirty_domains ?? []).length === 0) {
    assert.deepEqual(
      after.dirty_domains,
      domainOrder.filter((domain) => marks.includes(domain)),
      label,
    );
  }
  for (const domain of marks) {
    assert.ok(after.dirty_domains.includes(domain), `${label}: ${domain}`);
  }
  return after;
};

const triggerListing = async () => {
  const rows = await psql(
    "SELECT c.relname || ':' || t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND (t.tgname LIKE 'finki_hub%' OR t.tgname LIKE '%_write_guard') ORDER BY 1",
  );
  return rows.map(([row]) => row);
};

const functionDigests = async () => {
  const rows = await psql(
    "SELECT proname || ':' || md5(prosrc) FROM pg_proc WHERE proname IN ('finki_hub_source_invalidation', 'finki_hub_write_guard') ORDER BY 1",
  );
  return rows.map(([row]) => row);
};

const appliesTwice = async (directus, state, log) => {
  const first = await applySourceInvalidation(directus);
  const triggers = needsDatabase === false ? await triggerListing() : [];
  const digests = needsDatabase === false ? await functionDigests() : [];
  const second = await applySourceInvalidation(directus);
  assert.deepEqual(first, {
    applied: 'source-invalidation',
    statements: sourceInvalidation.statements.length,
  });
  assert.deepEqual(second, first);
  if (needsDatabase === false) {
    assert.deepEqual(await triggerListing(), triggers);
    assert.deepEqual(await functionDigests(), digests);
  }
  log(`first ${JSON.stringify(first)}, second ${JSON.stringify(second)}`);
  log(`functions ${digests.join(', ')}`);
  Object.assign(state, { triggers });
};

// The live triggers are the generated ones: one invalidation trigger per
// registered source (the optional checkpoint tables exist here), the entry
// label trigger, and one write guard per guarded table.
const installsTheRegistry = (state, log) => {
  const expected = sorted([
    ...sourceDeclarations.map(
      ({ collection }) => `${collection}:finki_hub_source_invalidation`,
    ),
    ...sourceDeclarations.flatMap(({ collection, columns = {} }) =>
      Object.values(columns).map(
        ({ trigger: name }) => `${collection}:${name}`,
      ),
    ),
    ...guardedDeclarations.map(
      ({ collection }) => `${collection}:${collection}_write_guard`,
    ),
  ]);
  assert.deepEqual(sorted(state.triggers), expected);
  log(`${state.triggers.length} triggers: ${state.triggers.join(' ')}`);
  assert.deepEqual(
    sorted(collectionDeclarations.map(({ collection }) => collection)),
    sorted(dataModelCollectionKeys),
  );
};

const marksEverySourceClass = async (target, state, log) => {
  const classes = new Map();
  for (const declaration of sourceDeclarations) {
    const members = classes.get(signature(declaration)) ?? [];
    classes.set(signature(declaration), [...members, declaration]);
  }
  let before = await statusOf(target);
  assert.deepEqual(before.dirty_domains ?? [], [], 'nothing is pending yet');
  for (const members of classes.values()) {
    const declaration = members.find((member) =>
      Object.hasOwn(payloads, member.collection),
    );
    const names = members.map((member) => member.collection).join(', ');
    assert.ok(declaration, `a representative payload for ${names}`);
    const { collection } = declaration;
    const created = await post(
      target,
      `/items/${collection}`,
      payloads[collection],
    );
    state.items.unshift([collection, created.data.id]);
    log(`class of ${names}: ${signature(declaration)}`);
    before = await assertMarked(target, {
      before,
      label: `insert into ${collection}`,
      log,
      marks: expectedMarks(declaration, 'insert'),
    });
    const columns = Object.keys(declaration.columns ?? {});
    for (const column of columns) {
      await patch(target, `/items/${collection}/${created.data.id}`, {
        [column]: `${payloads[collection][column]} (edited)`,
      });
      before = await assertMarked(target, {
        before,
        label: `update of ${collection}.${column}`,
        log,
        marks: expectedMarks(declaration, 'update', column),
      });
    }
    if (declaration.onDelete !== undefined) {
      await remove(target, `/items/${collection}/${created.data.id}`);
      state.items.shift();
      before = await assertMarked(target, {
        before,
        label: `delete from ${collection}`,
        log,
        marks: expectedMarks(declaration, 'delete'),
      });
    }
  }
};

const installProbeFlow = async (target) => {
  await post(target, '/flows', {
    accountability: 'activity',
    description:
      'Synthetic probe of the derived write guards; removed by the test that installs it.',
    icon: 'block',
    id: probeFlowId,
    name: 'Synthetic write guard probe',
    options: {
      async: false,
      collections: ['data_operations'],
      error_on_reject: true,
      requireSelection: false,
    },
    status: 'inactive',
    trigger: 'manual',
  });
  await post(target, '/operations', {
    flow: probeFlowId,
    id: probeOperationId,
    key: 'create_item',
    name: 'Create one item without events',
    options: {
      collection: '{{ $trigger.body.target }}',
      emitEvents: false,
      payload: '{{ $trigger.body.payload }}',
      permissions: '$full',
    },
    position_x: 19,
    position_y: 1,
    type: 'item-create',
  });
  await patch(target, `/flows/${probeFlowId}`, {
    operation: probeOperationId,
    status: 'active',
  });
};

// Every guarded table refuses create, update and delete through REST with
// the registry's refusal; an event-less Flow write, which no hook sees, is
// refused by the database guard. Nothing is written and nothing marked.
const refusesDirectWrites = async (target, state, log) => {
  const course = await post(target, '/items/courses', {
    name: 'Synthetic Roles Guarded Course',
  });
  state.items.unshift(['courses', course.data.id]);
  const year = state.items.find(([name]) => name === 'academic_years');
  const pair = { academic_year: year?.[1], course: course.data.id };
  // Complete, valid rows: only a guard can refuse them.
  const rows = {
    course_enrollments: {
      ...pair,
      computed_at: '2091-09-01T00:00:00.000Z',
      computed_revision: 1,
      count: 3,
    },
    data_operation_results: {
      ...pair,
      claim_token: '9e4d826c-0000-4000-8000-000000002403',
      count: 3,
      page_token: 'p0001',
      revision: 1,
    },
  };
  const before = await statusOf(target);
  for (const { collection } of guardedDeclarations) {
    for (const [method, path, body] of [
      ['POST', `/items/${collection}`, rows[collection] ?? {}],
      ['PATCH', `/items/${collection}/1`, rows[collection] ?? {}],
      ['DELETE', `/items/${collection}/1`, null],
    ]) {
      const response = await request(
        target,
        path,
        body === null
          ? { method, token: target.token }
          : json(method, body, target.token),
      );
      const answer = await response.json();
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal(errorCode(answer), guarded, `${method} ${path}`);
      assert.match(answer.errors[0].message, refusalPattern);
    }
    log(`${collection}: POST, PATCH, DELETE -> 403 ${guarded}`);
  }
  // Flagged before the first request: a probe Flow a failed install left
  // half made is removed by the cleanup all the same.
  Object.assign(state, { probeInstalled: true });
  await installProbeFlow(target);
  for (const collection of ['course_enrollments', 'data_operation_results']) {
    const probe = await trigger(target, `/flows/trigger/${probeFlowId}`, {
      collection: 'data_operations',
      payload: rows[collection],
      target: collection,
    });
    assert.equal(probe.status, 500, JSON.stringify(probe.body));
    // The refusal is the database guard's own, not any other failure of
    // the insert (a stale payload, a missing column, a foreign key).
    assert.ok(
      probe.body?.errors?.[0]?.message?.includes(
        guardMessage(declarationOf(collection)),
      ),
      JSON.stringify(probe.body),
    );
    assert.equal(await count(target, collection), 0, collection);
    log(
      `event-less create on ${collection}: HTTP ${probe.status} ${errorCode(probe.body)} "${probe.body?.errors?.[0]?.message ?? ''}", rows 0`,
    );
  }
  const after = await statusOf(target);
  assert.equal(
    after.source_revision,
    before.source_revision,
    'refused writes to guarded tables mark nothing',
  );
  // The control: the same event-less create succeeds on a source table.
  const control = await trigger(target, `/flows/trigger/${probeFlowId}`, {
    collection: 'data_operations',
    payload: { name: 'Synthetic Roles Probe Course' },
    target: 'courses',
  });
  assert.equal(control.status, 200, JSON.stringify(control.body));
  const [probed] = await get(
    target,
    '/items/courses?fields=id&filter[name][_eq]=Synthetic%20Roles%20Probe%20Course',
  );
  assert.ok(probed, 'the control course exists');
  state.items.unshift(['courses', probed.id]);
  log(`event-less create on courses: HTTP ${control.status}`);
  await assertMarked(target, {
    before: after,
    label: 'event-less source write',
    log,
    marks: ['publication'],
  });
};

const cleansUp = async (target, state) => {
  if (state.probeInstalled) {
    // Its operations go with it; a Flow the install never created answers
    // 403 or 404.
    const response = await request(target, `/flows/${probeFlowId}`, {
      method: 'DELETE',
      token: target.token,
    });
    await response.text();
    assert.ok([204, 403, 404].includes(response.status), probeFlowId);
  }
  for (const [collection, id] of state.items) {
    await remove(target, `/items/${collection}/${id}`);
  }
  for (const collection of dataModelCollectionKeys) {
    if (collection === 'data_operations') continue;
    assert.equal(await count(target, collection), 0, collection);
  }
};

test('declares collection roles once and installs what they generate', async (t) => {
  const target = targetFrom(process.env);
  const directus = adminRequest(target);
  const state = { items: [], probeInstalled: false, triggers: [] };

  await withDataModel(target, async () => {
    try {
      await installDataModel(directus);
      await applySchemaConstraints(directus);
      await t.test(
        'applies the generated source-invalidation migration twice',
        (step) => appliesTwice(directus, state, logOf(step)),
      );
      await t.test(
        'installs exactly the triggers and guards of the registry',
        { skip: needsDatabase },
        (step) => installsTheRegistry(state, logOf(step)),
      );
      await t.test(
        'marks the declared domains for one edit of each source class',
        (step) => marksEverySourceClass(target, state, logOf(step)),
      );
      await t.test(
        'refuses direct writes to the derived and candidate tables',
        (step) => refusesDirectWrites(target, state, logOf(step)),
      );
    } finally {
      await t.test('removes exactly what it created', () =>
        cleansUp(target, state),
      );
    }
  });

  await assertMarkerPresent(target);
  assert.deepEqual(await userCollections(target), [target.markerCollection]);
});
