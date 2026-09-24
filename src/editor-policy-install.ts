import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import type { DirectusRequest } from './directus-request.js';

import { editorPolicy } from '../directus/extensions/directus-extension-data-operations/src/managed-flows.js';
import { derivedGrants, grant, type PermissionSpec } from './editor-policy.js';

// The installed editor policy. npm run setup creates it once and keeps it
// equal to the derivation on every run: the policy row's access flags and
// its permissions are code-owned, so a hand edit is aligned back and a
// grant the derivation no longer holds is removed. Setup attaches it to no
// role or user; an administrator does (README).

// What an editor needs of Directus itself: the dashboards and their panels
// (Insights shows a dashboard only with both), and the manual Flows whose
// dialogs a Run operation panel shows (Directus's own recommended read of
// Flows: manual ones only, no operation). Running a Flow still needs read
// access to its collection (data_operations, which no editor reads) and
// passes the Flow's own administrator check.
export const studioGrants: readonly PermissionSpec[] = [
  grant('directus_dashboards', 'read'),
  grant('directus_panels', 'read'),
  {
    action: 'read',
    collection: 'directus_flows',
    fields: [
      'id',
      'name',
      'description',
      'icon',
      'color',
      'status',
      'trigger',
      'options',
    ],
    permissions: { trigger: { _eq: 'manual' } },
  },
];

// Every permission of the installed policy: the grants derived from the
// collection roles, then Studio's own reads.
export const editorPolicyPermissions = (): readonly PermissionSpec[] => [
  ...derivedGrants(),
  ...studioGrants,
];

// The policy itself: Studio access, no administrator access. Holders read
// the data status (the status endpoint checks this id).
export const editorPolicyDefinition = {
  admin_access: false,
  app_access: true,
  description:
    'Edits the source collections, reads the derived ones and the data status. Derived by npm run setup from the collection roles, which keeps it equal to that derivation: change the code, not this policy.',
  enforce_tfa: false,
  icon: 'edit_note',
  id: editorPolicy.id,
  ip_access: null,
  name: editorPolicy.name,
} as const;

const livePolicies = z.array(
  z.object({
    admin_access: z.boolean(),
    app_access: z.boolean(),
    description: z.string().nullable(),
    enforce_tfa: z.boolean(),
    icon: z.string().nullable(),
    id: z.string(),
    ip_access: z.unknown(),
    name: z.string(),
  }),
);

const livePermissions = z.array(
  z.object({
    action: z.string(),
    collection: z.string(),
    fields: z.array(z.string()).nullable(),
    id: z.number().int(),
    permissions: z.unknown(),
    presets: z.unknown(),
    validation: z.unknown(),
  }),
);

type LivePermission = z.infer<typeof livePermissions>[number];

export type EditorPolicySummary = {
  readonly created: number;
  readonly deleted: number;
  readonly policy: 'aligned' | 'created' | 'unchanged';
  readonly unchanged: number;
  readonly updated: number;
};

const json = (body: unknown, method: 'DELETE' | 'PATCH' | 'POST') => ({
  body: JSON.stringify(body),
  method,
});

const keyOf = ({ action, collection }: LivePermission | PermissionSpec) =>
  `${collection}\u{0}${action}`;

const collator = new Intl.Collator('en');

const sorted = (fields: null | readonly string[]): string[] =>
  (fields ?? []).toSorted((left, right) => collator.compare(left, right));

// Whether a live permission already is the derived one.
export const samePermission = (
  live: LivePermission,
  spec: PermissionSpec,
): boolean =>
  isDeepStrictEqual(sorted(live.fields), sorted(spec.fields)) &&
  isDeepStrictEqual(live.permissions ?? {}, spec.permissions) &&
  live.validation === null &&
  live.presets === null;

const permissionBody = (spec: PermissionSpec) => ({
  fields: [...spec.fields],
  permissions: spec.permissions,
  presets: null,
  validation: null,
});

const policyPath = `/policies?fields=id,name,description,icon,admin_access,app_access,enforce_tfa,ip_access&limit=1&filter[id][_eq]=${editorPolicy.id}`;
const permissionsPath = `/permissions?fields=id,collection,action,fields,permissions,validation,presets&limit=-1&filter[policy][_eq]=${editorPolicy.id}`;

// Creates the policy when missing, else aligns its row; then creates the
// missing permissions, aligns the drifted ones and deletes the rest.
export const installEditorPolicy = async (
  request: DirectusRequest,
  permissions: readonly PermissionSpec[] = editorPolicyPermissions(),
): Promise<EditorPolicySummary> => {
  const { id, ...row } = editorPolicyDefinition;
  const [existing] = livePolicies.parse(await request(policyPath));
  let policy: EditorPolicySummary['policy'] = 'unchanged';
  if (existing === undefined) {
    await request('/policies', json(editorPolicyDefinition, 'POST'));
    policy = 'created';
  } else if (
    !isDeepStrictEqual(
      { ...existing, ip_access: existing.ip_access ?? null },
      editorPolicyDefinition,
    )
  ) {
    await request(`/policies/${id}`, json(row, 'PATCH'));
    policy = 'aligned';
  }
  const wanted = new Map(permissions.map((spec) => [keyOf(spec), spec]));
  const seen = new Set<string>();
  const stale: number[] = [];
  let unchanged = 0;
  let updated = 0;
  const installed = livePermissions.parse(await request(permissionsPath));
  for (const live of installed) {
    const key = keyOf(live);
    const spec = wanted.get(key);
    if (spec === undefined || seen.has(key)) {
      stale.push(live.id);
    } else if (samePermission(live, spec)) {
      unchanged += 1;
    } else {
      await request(
        `/permissions/${String(live.id)}`,
        json(permissionBody(spec), 'PATCH'),
      );
      updated += 1;
    }
    seen.add(key);
  }
  if (stale.length > 0) {
    await request('/permissions', json(stale, 'DELETE'));
  }
  const missing = permissions.filter((spec) => !seen.has(keyOf(spec)));
  if (missing.length > 0) {
    await request(
      '/permissions',
      json(
        missing.map((spec) => ({
          action: spec.action,
          collection: spec.collection,
          policy: id,
          ...permissionBody(spec),
        })),
        'POST',
      ),
    );
  }
  return {
    created: missing.length,
    deleted: stale.length,
    policy,
    unchanged,
    updated,
  };
};
