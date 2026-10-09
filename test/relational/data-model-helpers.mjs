import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { dataModelCollectionKeys } from '../../src/data-model/collections.js';
import { operationsDashboardId } from '../../src/data-model/operations-dashboard.js';
import { folders } from '../../src/data-model/presentation/navigation.js';
import { presetDefinitions } from '../../src/data-model/presentation/presets.js';
import { modelRelations } from '../../src/data-model/relations.js';
import { createDirectusRequest } from '../../src/directus-request.js';
import { processPendingFlowId } from '../../src/flows/process-pending.js';
import { incompleteDataPresets } from '../../src/import/incomplete-data-bookmarks.js';
import { assertMarkerPresent } from '../isolated-target.mjs';

const systemPrefix = 'directus_';
const restrictedUserPrefix = 'relational-restricted-';

export const request = (target, path, requestOptions = {}) => {
  const headers = new Headers(requestOptions.headers);
  if (requestOptions.token)
    headers.set('authorization', `Bearer ${requestOptions.token}`);
  return fetch(new URL(path, target.base), {
    ...requestOptions,
    headers,
    signal: AbortSignal.timeout(60_000),
  });
};

export const read = async (httpResponse, status) => {
  const body = await httpResponse.text();
  if (httpResponse.status !== status)
    assert.fail(
      `${httpResponse.url} returned HTTP ${httpResponse.status} (expected ${status}): ${body}`,
    );
  return body === '' ? null : JSON.parse(body);
};

export const json = (method, body, token = null) => ({
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
  method,
  token,
});

export const adminRequest = (target) =>
  createDirectusRequest({ token: target.token, url: target.base });

// Wraps a DirectusRequest and records every call so a test can prove that a
// run issued no mutating request at all.
export const recording = (directusRequest) => {
  const calls = [];
  return {
    calls,
    mutations: () => calls.filter(({ method }) => method !== 'GET'),
    request: (pathname, init) => {
      calls.push({ method: init?.method ?? 'GET', pathname });
      return directusRequest(pathname, init);
    },
  };
};

export const userCollections = async (target) => {
  const listing = await read(
    await request(target, '/collections', { token: target.token }),
    200,
  );
  return listing.data
    .map(({ collection }) => collection)
    .filter((collection) => !collection.startsWith(systemPrefix));
};

export const schemaCounts = async (target) => {
  const counts = {};
  for (const [key, path] of [
    ['collections', '/collections'],
    ['fields', '/fields'],
    ['relations', '/relations'],
    ['presets', '/presets?limit=-1'],
  ]) {
    const listing = await read(
      await request(target, path, { token: target.token }),
      200,
    );
    counts[key] = listing.data.length;
  }
  return counts;
};

// Collections ordered so that every "many" side is deleted before the
// collection it references; dropping a referenced table first would fail.
export const teardownOrder = () => {
  const remaining = new Set(dataModelCollectionKeys);
  const order = [];
  while (remaining.size > 0) {
    const free = [...remaining].filter((collection) =>
      modelRelations.every(
        (relation) =>
          !(
            relation.related === collection &&
            relation.collection !== collection &&
            remaining.has(relation.collection)
          ),
      ),
    );
    assert.ok(free.length > 0, 'The relational model has a reference cycle');
    for (const collection of free) {
      order.push(collection);
      remaining.delete(collection);
    }
  }
  return order;
};

const remove = async (target, path) =>
  read(
    await request(target, path, { method: 'DELETE', token: target.token }),
    204,
  );

// The global presets `installPresentation` declares and the
// incomplete-data bookmarks the import creates (matched by collection and
// bookmark name), deleted before their collections go so nothing dangles.
const declaredPresets = [...presetDefinitions, ...incompleteDataPresets()];

const destroyPresets = async (target) => {
  const listing = await read(
    await request(
      target,
      '/presets?limit=-1&fields=id,bookmark,collection,user,role',
      { token: target.token },
    ),
    200,
  );
  const declared = listing.data.filter(
    (preset) =>
      preset.user === null &&
      preset.role === null &&
      declaredPresets.some(
        (definition) =>
          definition.collection === preset.collection &&
          definition.bookmark === preset.bookmark,
      ),
  );
  for (const preset of declared) await remove(target, `/presets/${preset.id}`);
};

// The sidebar folders `installPresentation` creates; a folder is a
// table-less collection row, so dropping it touches no data.
const destroyFolders = async (target) => {
  const present = new Set(await userCollections(target));
  for (const folder of folders) {
    if (!present.has(folder.collection)) continue;
    await remove(target, `/collections/${folder.collection}`);
  }
};

// The Data operations dashboard (its panels go with it) that `npm run
// setup` installs; nothing when it is absent.
const destroyOperations = async (target) => {
  const present = await read(
    await request(
      target,
      `/dashboards?fields=id&filter[id][_eq]=${operationsDashboardId}`,
      { token: target.token },
    ),
    200,
  );
  if (present.data.length > 0)
    await remove(target, `/dashboards/${operationsDashboardId}`);
};

export const destroyDataModel = async (target) => {
  await destroyOperations(target);
  await destroyPresets(target);
  const present = new Set(await userCollections(target));
  const failures = [];
  for (const collection of teardownOrder()) {
    if (!present.has(collection)) continue;
    try {
      await remove(target, `/collections/${collection}`);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      'Data model teardown did not remove every collection',
    );
  await destroyFolders(target);
};

const flowStatus = async (target, id) => {
  const listing = await read(
    await request(target, `/flows?fields=status&filter[id][_eq]=${id}`, {
      token: target.token,
    }),
    200,
  );
  return listing.data[0]?.status ?? null;
};

const setFlowStatus = async (target, id, status) =>
  read(
    await request(
      target,
      `/flows/${id}`,
      json('PATCH', { status }, target.token),
    ),
    200,
  );

// The scheduled Data / Process pending claims pending work every 15
// seconds. A suite that drives the coordinator by hand pauses it (status
// inactive, which the managed-graph fingerprint does not cover) and the
// returned function restores the status it found; nothing when the Flow is
// not installed or already inactive.
export const pauseAutomaticProcessing = async (target) => {
  if ((await flowStatus(target, processPendingFlowId)) !== 'active') {
    return () => Promise.resolve();
  }
  await setFlowStatus(target, processPendingFlowId, 'inactive');
  return async () => {
    if ((await flowStatus(target, processPendingFlowId)) === 'inactive') {
      await setFlowStatus(target, processPendingFlowId, 'active');
    }
  };
};

const runOnDataModel = async (target, body) => {
  await assertMarkerPresent(target);
  const collections = await userCollections(target);
  const existing = collections.filter((collection) =>
    dataModelCollectionKeys.includes(collection),
  );
  assert.deepEqual(
    existing,
    [],
    'The fixture must not carry model collections before the run',
  );
  let failure;
  let failed = false;
  try {
    await body();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await destroyDataModel(target);
  } catch (cleanupError) {
    if (failed)
      throw new AggregateError(
        [failure, cleanupError],
        'Data model test failed and teardown did not complete',
        { cause: cleanupError },
      );
    throw cleanupError;
  }
  if (failed) throw failure;
};

// Runs a suite over a data model it installs and tears down. Unless the
// suite asks for automatic processing, the scheduled Flow is paused for
// the run and resumed afterwards.
export const withDataModel = async (target, body, options = {}) => {
  const resume = options.automatic
    ? () => Promise.resolve()
    : await pauseAutomaticProcessing(target);
  try {
    await runOnDataModel(target, body);
  } finally {
    await resume();
  }
};

// A synthetic user with a static token and no policies at all.
export const withRestrictedUser = async (target, body) => {
  const role = await read(
    await request(
      target,
      '/roles',
      json(
        'POST',
        { icon: 'lock', name: `Relational restriction ${randomUUID()}` },
        target.token,
      ),
    ),
    200,
  );
  let user;
  try {
    const token = `synthetic-${randomUUID()}`;
    user = await read(
      await request(
        target,
        '/users',
        json(
          'POST',
          {
            email: `${restrictedUserPrefix}${randomUUID()}@example.com`,
            role: role.data.id,
            status: 'active',
            token,
          },
          target.token,
        ),
      ),
      200,
    );
    await body(token);
  } finally {
    try {
      if (user)
        await read(
          await request(target, `/users/${user.data.id}`, {
            method: 'DELETE',
            token: target.token,
          }),
          204,
        );
    } finally {
      await read(
        await request(target, `/roles/${role.data.id}`, {
          method: 'DELETE',
          token: target.token,
        }),
        204,
      );
    }
  }
};

// The fixture must hold only its administrator role and none of the
// synthetic restricted users once a run is over.
export const assertNoAccessResidue = async (target) => {
  const roles = await read(
    await request(target, '/roles?fields=name', { token: target.token }),
    200,
  );
  assert.deepEqual(
    roles.data.map(({ name }) => name),
    ['Administrator'],
    'Only the administrator role may remain',
  );
  const users = await read(
    await request(
      target,
      `/users?fields=email&filter[email][_starts_with]=${restrictedUserPrefix}`,
      { token: target.token },
    ),
    200,
  );
  assert.deepEqual(users.data, [], 'No restricted user may remain');
};

export const errorCode = (body) => body?.errors?.[0]?.extensions?.code ?? null;

export const createItem = async (target, collection, item) =>
  read(
    await request(
      target,
      `/items/${collection}`,
      json('POST', item, target.token),
    ),
    200,
  );

// Attempts a create that the domain rules must reject with a 400 and
// returns the error code Directus reported.
export const rejectedItem = async (target, collection, item) => {
  const body = await read(
    await request(
      target,
      `/items/${collection}`,
      json('POST', item, target.token),
    ),
    400,
  );
  return errorCode(body);
};
