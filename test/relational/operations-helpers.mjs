import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { editorPolicy } from '../../directus/extensions/directus-extension-data-operations/src/managed-flows.js';
import { editorPolicyPermissions } from '../../src/editor-policy-install.js';
import { get, post, remove } from './history-index-helpers.mjs';

// The helpers of the operations scenario (operations.integration.mjs):
// requests as a given caller, the synthetic editor and plain users, and
// the installed editor policy in a comparable form. Every user is
// synthetic, uses an example.com address and is removed by the scenario.

const restrictedPrefix = 'relational-restricted-';

// One request as a caller (a static token, or none for anonymous): the
// status and the parsed body, never an assertion.
export const callAs = async (target, token, { body, method = 'GET', path }) => {
  const headers = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const response = await fetch(new URL(path, target.base), {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
    method,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  return {
    body: text === '' ? null : JSON.parse(text),
    status: response.status,
  };
};

export const codeOf = (answer) =>
  answer.body?.errors?.[0]?.extensions?.code ?? null;

// POST /flows/trigger/:id the way the Run operation panel posts it.
export const runFlow = (target, token, { id, values = {} }) =>
  callAs(target, token, {
    body: { ...values, collection: 'data_operations' },
    method: 'POST',
    path: `/flows/trigger/${id}`,
  });

const syntheticUser = async (target, role) => {
  const token = `synthetic-${randomUUID()}`;
  const user = await post(target, '/users', {
    email: `${restrictedPrefix}${randomUUID()}@example.com`,
    role,
    status: 'active',
    token,
  });
  return { id: user.data.id, token };
};

// An editor (a role holding the editor policy) and a plain user (a role
// without any policy), both with static tokens; removed afterwards.
export const withAccessUsers = async (target, body) => {
  const created = { roles: [], users: [] };
  try {
    const editorRole = await post(target, '/roles', {
      icon: 'edit_note',
      name: `Relational restriction editor ${randomUUID()}`,
    });
    created.roles.push(editorRole.data.id);
    await post(target, '/access', {
      policy: editorPolicy.id,
      role: editorRole.data.id,
    });
    const plainRole = await post(target, '/roles', {
      icon: 'lock',
      name: `Relational restriction plain ${randomUUID()}`,
    });
    created.roles.push(plainRole.data.id);
    const editor = await syntheticUser(target, editorRole.data.id);
    created.users.push(editor.id);
    const plain = await syntheticUser(target, plainRole.data.id);
    created.users.push(plain.id);
    await body({ editor: editor.token, plain: plain.token });
  } finally {
    for (const id of created.users) await remove(target, `/users/${id}`);
    for (const id of created.roles) await remove(target, `/roles/${id}`);
  }
};

const byText = (left, right) => left.localeCompare(right, 'en');

// A permission as collection, action, sorted fields and filter text.
const comparable = ({ action, collection, fields, permissions }) =>
  JSON.stringify([
    collection,
    action,
    [...(fields ?? [])].toSorted(byText),
    permissions ?? {},
  ]);

export const installedPermissions = (target) =>
  get(
    target,
    `/permissions?fields=collection,action,fields,permissions,validation,presets&limit=-1&filter[policy][_eq]=${editorPolicy.id}`,
  );

// The installed editor policy equals the derivation, grant for grant.
export const assertPolicyDerived = async (target) => {
  const installed = await installedPermissions(target);
  assert.deepEqual(
    installed.map(comparable).toSorted(byText),
    editorPolicyPermissions().map(comparable).toSorted(byText),
  );
  assert.ok(
    installed.every(
      ({ presets, validation }) => presets === null && validation === null,
    ),
  );
  return installed;
};

// The keys of an object tree, at any depth.
export const keysDeep = (value) => {
  if (Array.isArray(value)) return value.flatMap(keysDeep);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, inner]) => [
    key,
    ...keysDeep(inner),
  ]);
};
