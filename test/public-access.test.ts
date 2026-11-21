import { describe, expect, test } from 'vitest';

import type { DirectusRequest } from '../src/directus-request.js';

import {
  examScheduleFiles,
  installedReads,
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
// The fields a collection's read declares.
const fieldsOf = (collection: string): readonly string[] => {
  const read = installedReads.find((r) => r.collection === collection);
  return read === undefined || read.fields === '*' ? ['*'] : read.fields;
};

const fakeDirectus = (state: {
  readonly fields?: Readonly<Record<string, readonly string[]>>;
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
    if (method === 'PATCH') {
      return Promise.resolve({});
    }
    const policy = policyFilter.exec(path)?.groups?.['policy'] ?? '';
    return Promise.resolve(
      (state.readable[policy] ?? []).map((collection, index) => ({
        collection,
        fields: state.fields?.[collection] ?? fieldsOf(collection),
        id: index + 1,
      })),
    );
  };
  return { calls, request };
};

const writes = (calls: readonly Call[]) =>
  calls.filter(({ method }) => method === 'POST' || method === 'PATCH');

describe('the public and MCP read permissions', () => {
  test('name collections of the model, each once', () => {
    const collections = publicReads.map(({ collection }) => collection);

    expect(new Set(collections).size).toBe(collections.length);
    expect(
      collections.filter((key) => !dataModelCollectionKeys.includes(key)),
    ).toEqual([]);
  });

  test('keep the Moodle users, the operations, non-council students and index numbers private', () => {
    const collections = publicReads.map(({ collection }) => collection);

    expect(collections).not.toContain('moodle_users');
    expect(collections).not.toContain('data_operations');
    expect(
      publicReads.find(({ collection }) => collection === 'students'),
    ).toEqual({
      collection: 'students',
      fields: ['id', 'name', 'council_memberships'],
      filter: { council_memberships: { _some: { id: { _nnull: true } } } },
    });
    expect(
      publicReads.find(({ collection }) => collection === 'student_council'),
    ).toEqual({
      collection: 'student_council',
      fields: ['id', 'year', 'position', 'student'],
    });
  });

  test('open only the exam schedule folder of the uploaded files', () => {
    expect(examScheduleFiles).toEqual({
      collection: 'directus_files',
      fields: ['id', 'filename_download', 'type', 'filesize'],
      filter: { folder: { name: { _eq: 'Exam sessions' } } },
    });
    expect(installedReads).toContain(examScheduleFiles);
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
    expect(writes(calls)[3]?.body).toHaveLength(installedReads.length);
    expect(summary.created).toContain(`policy ${mcpAccess.policy}`);
    expect(summary.skipped).toEqual([]);
  });

  test('adds only the missing reads and keeps the existing ones', async () => {
    const all = installedReads.map(({ collection }) => collection);
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
    expect(summary.skipped).toHaveLength(2 * installedReads.length - 1);
  });

  test('brings an existing read up to its declared fields', async () => {
    const all = installedReads.map(({ collection }) => collection);
    const courses = fieldsOf('courses');
    const { calls, request } = fakeDirectus({
      fields: { courses: courses.slice(0, -1) },
      mcpPolicy: 'mcp-policy',
      readable: { 'mcp-policy': all, 'public-policy': all },
    });

    const summary = await installPublicAccess(request);

    const index = all.indexOf('courses') + 1;

    expect(writes(calls)).toEqual([
      {
        body: { fields: [...courses] },
        method: 'PATCH',
        path: `/permissions/${index}`,
      },
      {
        body: { fields: [...courses] },
        method: 'PATCH',
        path: `/permissions/${index}`,
      },
    ]);
    expect(summary.updated).toEqual(['public courses', 'mcp courses']);
    expect(summary.created).toEqual([]);
  });
});
