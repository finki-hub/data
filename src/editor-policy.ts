import { z } from 'zod';

import type { DirectusRequest } from './directus-request.js';

import {
  type BookkeepingDeclaration,
  collectionDeclarations,
  type CollectionRole,
  type GuardedDeclaration,
  isGuarded,
  isSource,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/collection-roles.js';
import { readinessEntry } from '../directus/extensions/directus-extension-data-operations/src/exports/readiness-registry.js';

export type PermissionAction = 'create' | 'delete' | 'read' | 'update';

const allActions: readonly PermissionAction[] = [
  'create',
  'read',
  'update',
  'delete',
];
const writes: readonly PermissionAction[] = ['create', 'update', 'delete'];

export type ForbiddenGrant = {
  readonly actions: readonly PermissionAction[];
  readonly collection: string;
  readonly reason: string;
};

// What a normal editing role must never hold, for Task 16 to apply when it
// creates the first non-administrator role (none exists yet; this task
// creates no role). Moodle users change only through the controlled
// snapshot import: the native Import / Export sidebar needs create and
// update on the collection, so withholding them hides that shortcut, and a
// hand edit of a history would be overwritten by the next snapshot anyway.
// Every collection that is no source is withheld by its role in the
// collection-role registry: derived rows and the migration ledger are
// read-only, candidate, staging and status rows are private. The managed
// Flows run with $full and, on the schedule, without any accountability,
// so writing a Flow or an operation (or a permission, policy or its
// assignment) would lift every rule above.
const flowsReason =
  'The managed Flows read and write with $full, the schedule without accountability: editing them grants full data access and changes the calculation fingerprint.';
const accessReason =
  'Permissions, policies and their assignments decide every grant this template withholds.';

// What each role withholds from an editor.
export const forbiddenByRole: Readonly<
  Record<Exclude<CollectionRole, 'source'>, readonly PermissionAction[]>
> = {
  candidate: allActions,
  derived: writes,
  migration: writes,
  staging: allActions,
  status: allActions,
};

const capitalized = (text: string): string =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

const roleReason = (
  declaration: BookkeepingDeclaration | GuardedDeclaration,
): string => {
  const what = capitalized(declaration.description);
  if (isGuarded(declaration)) {
    return `${what}, written by ${declaration.guard.writtenBy} only.`;
  }
  return declaration.role === 'status'
    ? `${what}; its Flows and status are for administrators.`
    : `${what}: a completed step is never run again, so a hand edit could skip or repeat a migration.`;
};

const roleGrants: readonly ForbiddenGrant[] = collectionDeclarations.flatMap(
  (declaration) =>
    isSource(declaration)
      ? []
      : [
          {
            actions: forbiddenByRole[declaration.role],
            collection: declaration.collection,
            reason: roleReason(declaration),
          },
        ],
);

export const editorForbiddenGrants: readonly ForbiddenGrant[] = [
  {
    actions: writes,
    collection: 'moodle_users',
    reason:
      'Snapshots replace Moodle users only through Data / Import Moodle snapshot; the native CSV import alters raw values and replaces nothing atomically.',
  },
  ...roleGrants,
  { actions: writes, collection: 'directus_flows', reason: flowsReason },
  { actions: writes, collection: 'directus_operations', reason: flowsReason },
  { actions: writes, collection: 'directus_permissions', reason: accessReason },
  { actions: writes, collection: 'directus_policies', reason: accessReason },
  { actions: writes, collection: 'directus_access', reason: accessReason },
];

export type PermissionGrant = {
  readonly action: string;
  readonly collection: string;
};

// The grants of a policy that the template forbids, for a readiness check
// or a test of the role Task 16 creates.
export const forbiddenGrantsIn = (
  permissions: readonly PermissionGrant[],
): readonly PermissionGrant[] =>
  permissions.filter(({ action, collection }) =>
    editorForbiddenGrants.some(
      (rule) =>
        rule.collection === collection &&
        new Set<string>(rule.actions).has(action),
    ),
  );

// The part of GET /finki-hub-data-operations/snapshot the readiness check
// reads (Task 10): counts, fingerprints and states, never a row.
const snapshotReport = z.object({
  active: z.object({ fingerprint: z.string(), rows: z.number().int() }),
  activeMatchesPromotion: z.boolean().nullable(),
  promoted: z
    .object({ fingerprint: z.string(), rows: z.number().int() })
    .nullable(),
  state: z.string(),
});

export type SnapshotReadinessFinding = {
  readonly code: string;
  readonly message: string;
};

// A code of the readiness-check registry that readiness counts from the
// snapshot status too: the policy reports the same issue under the same
// code, and a code the registry drops fails here at load.
const snapshotCode = (code: string): string => {
  if (readinessEntry(code)?.source.kind !== 'snapshot') {
    throw new Error(`The readiness registry declares no snapshot code ${code}`);
  }
  return code;
};

export const activeSnapshotEdited = snapshotCode('active_snapshot_edited');
export const snapshotImportFailed = snapshotCode('snapshot_import_failed');

// Flags the unsupported writes the snapshot workflow can see: active Moodle
// users that no longer equal the snapshot the last promotion made active
// (an edit in Studio, over REST or through the native CSV import by an
// administrator, whom no policy restricts), and a failed import whose
// staging must not be promoted. Nothing is flagged before the first
// promotion.
export const snapshotReadiness = (
  report: unknown,
): readonly SnapshotReadinessFinding[] => {
  const parsed = snapshotReport.parse(report);
  const findings: SnapshotReadinessFinding[] = [];
  if (parsed.activeMatchesPromotion === false) {
    findings.push({
      code: activeSnapshotEdited,
      message: `The active Moodle users (${String(parsed.active.rows)} rows) no longer equal the snapshot the last promotion made active (${String(parsed.promoted?.rows ?? 0)} rows): they were changed outside Data / Import Moodle snapshot. The next promotion replaces those changes.`,
    });
  }
  if (parsed.state === 'failed') {
    findings.push({
      code: snapshotImportFailed,
      message:
        'The last snapshot import or promotion failed; the active Moodle users are unchanged by it and its staging is not promoted.',
    });
  }
  return findings;
};

// Reads the snapshot status (administrators only) and returns its
// findings. The status fingerprints every active Moodle user, so this is
// an on-demand check, never part of a scheduled path.
export const readSnapshotReadiness = async (
  request: DirectusRequest,
): Promise<readonly SnapshotReadinessFinding[]> =>
  snapshotReadiness(await request('/finki-hub-data-operations/snapshot'));
