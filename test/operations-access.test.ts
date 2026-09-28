import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { KeySource } from '../directus/extensions/directus-extension-data-operations/src/exports/types.js';
import type { DirectusRequest } from '../src/directus-request.js';

import {
  collectionDeclarations,
  isSource,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/collection-roles.js';
import { keySources } from '../directus/extensions/directus-extension-data-operations/src/exports/key-sources.js';
import { editorPolicy } from '../directus/extensions/directus-extension-data-operations/src/managed-flows.js';
import { decideAccess } from '../directus/extensions/directus-extension-data-operations/src/status-endpoint.js';
import { holdsPolicy } from '../directus/extensions/directus-extension-data-operations/src/status-reads.js';
import { dataModelCollectionKeys } from '../src/data-model/collections.js';
import {
  editorPolicyDefinition,
  editorPolicyPermissions,
  installEditorPolicy,
  studioGrants,
} from '../src/editor-policy-install.js';
import {
  filterPaths,
  keyedFields,
  keyedFieldsOf,
  keySourceFields,
} from '../src/editor-policy-keys.js';
import {
  derivedGrants,
  forbiddenGrantsIn,
  grantClasses,
  grantClassOf,
  type PermissionSpec,
} from '../src/editor-policy.js';
import { rulesId } from '../src/flows/flow-template.js';

// Task 16: the editor policy derived from the collection roles (audit X13)
// and the access boundary of the status read. The fixture scenario
// operations.integration.mjs checks the installed policy and the endpoint
// on a live project.

const classOf = (collection: string) => {
  const declaration = collectionDeclarations.find(
    (candidate) => candidate.collection === collection,
  );
  return declaration === undefined ? undefined : grantClassOf(declaration);
};

const actionsOn = (
  permissions: readonly PermissionSpec[],
  collection: string,
): string[] =>
  permissions
    .filter((permission) => permission.collection === collection)
    .map(({ action }) => action);

const fieldsOf = (collection: string, action: string) =>
  derivedGrants().find(
    (permission) =>
      permission.collection === collection && permission.action === action,
  )?.fields;

describe('the derived editor policy', () => {
  test('puts every model collection in exactly one grant class', () => {
    for (const collection of dataModelCollectionKeys) {
      const declared = collectionDeclarations.filter(
        (declaration) => declaration.collection === collection,
      );

      expect(declared.map((declaration) => declaration.collection)).toEqual([
        collection,
      ]);
      expect(grantClasses).toContain(classOf(collection));
    }

    expect(collectionDeclarations).toHaveLength(dataModelCollectionKeys.length);
  });

  test('derives the classes from the roles, the editor flags and the key sources', () => {
    expect(
      Object.fromEntries(
        [
          'courses',
          'moodle_course_mappings',
          'course_enrollment_rules',
          'academic_years',
          'curriculum_generations',
          'study_programs',
          'moodle_users',
          'course_enrollments',
          'moodle_history_memberships',
          'data_operations',
          'data_operation_results',
          'moodle_import_rows',
        ].map((collection) => [collection, classOf(collection)]),
      ),
    ).toEqual({
      academic_years: 'keyed',
      course_enrollment_rules: 'edit',
      course_enrollments: 'read',
      courses: 'edit',
      curriculum_generations: 'keyed',
      data_operation_results: 'none',
      data_operations: 'none',
      moodle_course_mappings: 'edit',
      moodle_history_memberships: 'read',
      moodle_import_rows: 'none',
      moodle_users: 'read',
      study_programs: 'keyed',
    });
  });

  test('grants each class its actions and nothing on a collection of class none', () => {
    const grants = derivedGrants();
    const expected = {
      edit: ['create', 'read', 'update', 'delete'],
      keyed: ['read', 'update'],
      none: [],
      read: ['read'],
    };

    expect(
      collectionDeclarations.map(({ collection }) => [
        collection,
        actionsOn(grants, collection),
      ]),
    ).toEqual(
      collectionDeclarations.map((declaration) => [
        declaration.collection,
        expected[grantClassOf(declaration)],
      ]),
    );

    const editable = collectionDeclarations
      .filter(isSource)
      .filter((declaration) => grantClassOf(declaration) === 'edit');

    expect(
      editable.map(({ collection }) => fieldsOf(collection, 'update')),
    ).toEqual(editable.map(() => ['*']));
  });

  test('holds no grant the literal deny-list forbids', () => {
    expect(forbiddenGrantsIn(editorPolicyPermissions())).toEqual([]);
    expect(forbiddenGrantsIn(derivedGrants())).toEqual([]);
  });

  test('adds only the reads Studio needs for the dashboard and the Flow dialogs', () => {
    expect(
      studioGrants.map(({ action, collection, permissions }) => [
        collection,
        action,
        permissions,
      ]),
    ).toEqual([
      ['directus_dashboards', 'read', {}],
      ['directus_panels', 'read', {}],
      ['directus_flows', 'read', { trigger: { _eq: 'manual' } }],
    ]);
    expect(editorPolicyDefinition).toMatchObject({
      admin_access: false,
      app_access: true,
      id: editorPolicy.id,
      name: editorPolicy.name,
    });
    expect(editorPolicy.id).toBe(rulesId('e1'));
  });
});

describe('the fields that decide public keys', () => {
  test('withholds every field a key source reads to place public keys', () => {
    expect(Object.fromEntries(keyedFields)).toEqual({
      academic_years: ['published', 'label', 'sort'],
      curriculum_generations: ['published', 'code', 'sort', 'has_curriculum'],
      study_programs: ['published', 'code', 'sort', 'generation'],
    });

    for (const [collection, withheld] of keyedFields) {
      const writable = fieldsOf(collection, 'update') ?? [];

      expect(writable.filter((field) => withheld.includes(field))).toEqual([]);
    }

    expect(fieldsOf('study_programs', 'update')).toEqual([
      'name',
      'description',
    ]);
    expect(fieldsOf('curriculum_generations', 'update')).toContain('label');
    expect(fieldsOf('curriculum_generations', 'update')).toContain('programs');
  });

  test('withholds the fields of a key source a later definition adds', () => {
    expect(
      keySourceFields({
        ...keySources.published_years,
        collection: 'synthetic_terms',
        filter: { _and: [{ published: { _eq: true } }, { open: { _eq: 1 } }] },
        key: 'code',
        parent: 'year',
        position: { field: 'rank', row: 'synthetic_term' },
      }),
    ).toEqual(
      ['published', 'code', 'rank', 'year', 'open'].map((field) => ({
        collection: 'synthetic_terms',
        field,
      })),
    );
  });

  test('withholds a field a key-source filter tests through a relation in the related collection', () => {
    // A later key source whose filter reads a field of courses, which is
    // no key source itself.
    const throughCourse: KeySource = {
      ...keySources.published_years,
      collection: 'course_curricula',
      fields: ['id', 'code'],
      filter: {
        _and: [
          { published: { _eq: true } },
          { course: { name: { _nnull: true } } },
        ],
      },
      key: 'code',
      position: { field: 'sort', row: 'synthetic_curriculum' },
    };
    const keyed = keyedFieldsOf([...Object.values(keySources), throughCourse]);
    const courses = collectionDeclarations.find(
      ({ collection }) => collection === 'courses',
    );
    if (courses === undefined) {
      throw new Error('courses is not declared');
    }
    const grants = derivedGrants(collectionDeclarations, keyed);
    const courseUpdate = grants.find(
      ({ action, collection }) =>
        collection === 'courses' && action === 'update',
    );

    expect(filterPaths(keySources.published_programs.filter)).toEqual([
      ['published'],
      ['generation', 'published'],
      ['generation', 'has_curriculum'],
    ]);
    expect(keyed.get('courses')).toEqual(['name']);
    expect(keyed.get('course_curricula')).toEqual([
      'published',
      'code',
      'sort',
      'course',
    ]);
    expect(grantClassOf(courses, keyed)).toBe('keyed');
    expect(actionsOn(grants, 'courses')).toEqual(['read', 'update']);
    expect(courseUpdate?.fields).not.toContain('name');
    expect(courseUpdate?.fields).toContain('tags');
    expect(forbiddenGrantsIn(grants)).toEqual([]);
  });

  test('refuses a key-source filter step that is no relation of the model', () => {
    expect(() =>
      keyedFieldsOf([
        {
          ...keySources.published_years,
          filter: { terms: { _some: { open: { _eq: true } } } },
        },
      ]),
    ).toThrow('terms is no M2O relation of the model');
  });
});

type Stored = Record<string, unknown> & { id: number };

type ProjectState = {
  permissions: Stored[];
  policy: null | Record<string, unknown>;
};

const recordSchema = z.record(z.string(), z.unknown());

const policyAnswer = (state: ProjectState): unknown[] =>
  state.policy === null ? [] : [state.policy];

// Applies one mutating request of the installer to the stored state.
const mutate = (
  state: ProjectState,
  { body, method, path }: { body: unknown; method: string; path: string },
): void => {
  if (path === '/policies') {
    state.policy = recordSchema.parse(body);
    return;
  }
  if (path.startsWith('/policies/')) {
    state.policy = { ...state.policy, ...recordSchema.parse(body) };
    return;
  }
  if (method === 'POST') {
    const created = z.array(recordSchema).parse(body);
    const base = state.permissions.length + 100;
    state.permissions.push(
      ...created.map((entry, index) => ({ ...entry, id: base + index })),
    );
    return;
  }
  if (method === 'DELETE') {
    const gone = new Set(z.array(z.number()).parse(body));
    state.permissions = state.permissions.filter(
      (entry) => !gone.has(entry.id),
    );
    return;
  }
  const id = Number(path.split('/').at(-1));
  state.permissions = state.permissions.map((entry) =>
    entry.id === id ? { ...entry, ...recordSchema.parse(body) } : entry,
  );
};

// A fake project that answers the installer and remembers what it stored.
const fakeProject = () => {
  const state: ProjectState = { permissions: [], policy: null };
  const mutations: Array<{ body: unknown; method: string; path: string }> = [];
  const request: DirectusRequest = async (path, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      return path.startsWith('/policies')
        ? policyAnswer(state)
        : state.permissions;
    }
    const body: unknown =
      typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    mutations.push({ body, method, path });
    mutate(state, { body, method, path });
    return {};
  };
  return { mutations, request, state };
};

describe('the editor policy installer', () => {
  test('creates the policy and every derived permission, then writes nothing on a rerun', async () => {
    const project = fakeProject();
    const first = await installEditorPolicy(project.request);

    expect(first).toEqual({
      created: editorPolicyPermissions().length,
      deleted: 0,
      policy: 'created',
      unchanged: 0,
      updated: 0,
    });
    expect(project.state.permissions).toHaveLength(
      editorPolicyPermissions().length,
    );
    expect(
      project.state.permissions.every(
        (entry) =>
          entry['policy'] === editorPolicy.id &&
          entry['validation'] === null &&
          entry['presets'] === null,
      ),
    ).toBeTruthy();

    project.mutations.length = 0;
    const again = await installEditorPolicy(project.request);

    expect(again).toMatchObject({
      created: 0,
      deleted: 0,
      policy: 'unchanged',
      updated: 0,
    });
    expect(project.mutations).toEqual([]);
  });

  test('aligns a hand edit back to the derivation', async () => {
    const project = fakeProject();
    await installEditorPolicy(project.request);
    const [first, second] = project.state.permissions;
    project.state.permissions.push({
      action: 'update',
      collection: 'moodle_users',
      fields: ['*'],
      id: 999,
      permissions: {},
      presets: null,
      validation: null,
    });
    if (first !== undefined) {
      first['fields'] = ['name'];
    }
    if (second !== undefined) {
      second['permissions'] = { id: { _eq: 1 } };
    }
    project.state.policy = { ...project.state.policy, admin_access: true };

    const aligned = await installEditorPolicy(project.request);

    expect(aligned).toMatchObject({
      created: 0,
      deleted: 1,
      policy: 'aligned',
      updated: 2,
    });
    expect(project.state.policy).toMatchObject({ admin_access: false });
    expect(
      forbiddenGrantsIn(
        project.state.permissions.map((entry) => ({
          action: String(entry['action']),
          collection: String(entry['collection']),
        })),
      ),
    ).toEqual([]);
  });
});

const never = () => Promise.resolve(false);
const always = () => Promise.resolve(true);

describe('the status read access boundary', () => {
  test('answers an anonymous caller 401 and never asks for the policy', async () => {
    const asked: unknown[] = [];
    const record = async (caller: unknown) => {
      asked.push(caller);
      return true;
    };

    for (const request of [
      {},
      { accountability: null },
      { accountability: { admin: false, role: null, roles: [], user: null } },
    ]) {
      await expect(decideAccess(request, record)).resolves.toMatchObject({
        ok: false,
        status: 401,
      });
    }

    expect(asked).toEqual([]);
  });

  test('lets an administrator in, an editor-policy holder in as an editor, and refuses the rest', async () => {
    const user = { admin: false, role: 'r1', roles: ['r0', 'r1'], user: 'u1' };

    await expect(
      decideAccess({ accountability: { ...user, admin: true } }, never),
    ).resolves.toEqual({ audience: 'administrator', ok: true });
    await expect(
      decideAccess({ accountability: user }, always),
    ).resolves.toEqual({ audience: 'editor', ok: true });
    await expect(
      decideAccess({ accountability: user }, never),
    ).resolves.toMatchObject({ code: 'FORBIDDEN', ok: false, status: 403 });
  });

  test('asks for the policy of the user and of every role of the tree', async () => {
    const calls: Array<{ bindings: unknown; sql: string }> = [];
    const held = await holdsPolicy(
      {
        raw: async (sql, bindings) => {
          calls.push({ bindings, sql });
          return { rows: [{ count: 1 }] };
        },
      },
      editorPolicy.id,
      { roles: ['r0', 'r1'], user: 'u1' },
    );

    expect(held).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.bindings).toEqual([
      editorPolicy.id,
      'u1',
      JSON.stringify(['r0', 'r1']),
    ]);
    expect(calls[0]?.sql).toContain('FROM "directus_access"');
  });
});
