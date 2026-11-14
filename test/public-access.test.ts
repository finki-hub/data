import { describe, expect, test } from 'vitest';

import type { DirectusRequest } from '../src/directus-request.js';

import {
  installPublicAccess,
  mcpAccess,
  publicReads,
} from '../src/data-model/access.js';
import { dataModelCollectionKeys } from '../src/data-model/collections.js';

const policyFilter = /filter\[policy\]\[_eq\]=(?<policy>[^&]+)/u;

type Call = {
  readonly body: unknown;
  readonly method: string;
  readonly path: string;
};

// A Directus that answers the access reads from `state` and records every
// write.
const fakeDirectus = (state: {
  readonly mcpPolicy: null | string;
  readonly readable: Readonly<Record<string, readonly string[]>>;
}) => {
  const calls: Call[] = [];
  const request: DirectusRequest = (path, init) => {
    const method = init?.method ?? 'GET';
    const body: unknown =
      typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ body, method, path });
    if (method === 'POST') {
      return Promise.resolve({ id: `new-${path.slice(1)}` });
    }
    if (path.startsWith('/access')) {
      return Promise.resolve([{ policy: 'public-policy' }]);
    }
    if (path.startsWith('/policies')) {
      return Promise.resolve(
        state.mcpPolicy === null ? [] : [{ id: state.mcpPolicy }],
      );
    }
    if (path.startsWith('/roles')) {
      return Promise.resolve([]);
    }
    const policy = policyFilter.exec(path)?.groups?.['policy'] ?? '';
    return Promise.resolve(
      (state.readable[policy] ?? []).map((collection) => ({ collection })),
    );
  };
  return { calls, request };
};

const writes = (calls: readonly Call[]) =>
  calls.filter(({ method }) => method === 'POST');

describe('the public and MCP read permissions', () => {
  test('name collections of the model, each once', () => {
    const collections = publicReads.map(({ collection }) => collection);

    expect(new Set(collections).size).toBe(collections.length);
    expect(
      collections.filter((key) => !dataModelCollectionKeys.includes(key)),
    ).toEqual([]);
  });

  test('keep the Moodle users, the operations and non-council students private', () => {
    const collections = publicReads.map(({ collection }) => collection);

    expect(collections).not.toContain('moodle_users');
    expect(collections).not.toContain('data_operations');
    expect(
      publicReads.find(({ collection }) => collection === 'students'),
    ).toEqual({
      collection: 'students',
      fields: ['id', 'name', 'index_number', 'council_memberships'],
      filter: { council_memberships: { _some: { id: { _nnull: true } } } },
    });
  });

  test('creates every read on a fresh project, with the MCP role and policy', async () => {
    const { calls, request } = fakeDirectus({ mcpPolicy: null, readable: {} });

    const summary = await installPublicAccess(request);

    expect(writes(calls).map(({ path }) => path)).toEqual([
      '/roles',
      '/policies',
      '/access',
      '/permissions',
      '/permissions',
    ]);
    expect(writes(calls)[2]?.body).toEqual({
      policy: 'new-policies',
      role: 'new-roles',
    });
    expect(writes(calls)[3]?.body).toHaveLength(publicReads.length);
    expect(summary.created).toContain(`policy ${mcpAccess.policy}`);
    expect(summary.skipped).toEqual([]);
  });

  test('adds only the missing reads and keeps the existing ones', async () => {
    const all = publicReads.map(({ collection }) => collection);
    const { calls, request } = fakeDirectus({
      mcpPolicy: 'mcp-policy',
      readable: {
        'mcp-policy': all,
        'public-policy': all.filter((key) => key !== 'anto_quotes'),
      },
    });

    const summary = await installPublicAccess(request);

    expect(writes(calls)).toEqual([
      {
        body: [
          {
            action: 'read',
            collection: 'anto_quotes',
            fields: ['*'],
            permissions: {},
            policy: 'public-policy',
            validation: {},
          },
        ],
        method: 'POST',
        path: '/permissions',
      },
    ]);
    expect(summary.created).toEqual(['public anto_quotes']);
    expect(summary.skipped).toHaveLength(2 * publicReads.length - 1);
  });
});
