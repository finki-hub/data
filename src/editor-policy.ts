import {
  type BookkeepingDeclaration,
  type CollectionDeclaration,
  collectionDeclarations,
  type CollectionRole,
  type GuardedDeclaration,
  isGuarded,
  isSource,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/collection-roles.js';
import { findModelCollection } from './data-model/collections.js';
import { aliasesFor } from './data-model/relations.js';
import { keyedFields } from './editor-policy-keys.js';

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

// What a normal editing role must never hold: the literal deny-list the
// derived editor policy below is checked against (forbiddenGrantsIn).
// Moodle users change only through the controlled snapshot import: the
// native Import / Export sidebar needs create and update on the
// collection, so withholding them hides that shortcut, and a hand edit of
// a history would be overwritten by the next snapshot anyway. Every
// collection that is no source is withheld by its role in the
// collection-role registry: derived rows are read-only, candidate, staging
// and status rows are private. The managed
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
  staging: allActions,
  status: allActions,
};

const capitalized = (text: string): string =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

const roleReason = (
  declaration: BookkeepingDeclaration | GuardedDeclaration,
): string => {
  const what = capitalized(declaration.description);
  return isGuarded(declaration)
    ? `${what}, written by ${declaration.guard.writtenBy} only.`
    : `${what}; its Flows and status are for administrators.`;
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

// The grants of a policy that the deny-list forbids; empty for the
// derived editor policy.
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

// The editor policy (Task 16), derived from the collection roles: every
// model collection falls in exactly one grant class.
// - edit: an editable source (create, read, update, delete);
// - keyed: a collection holding fields that decide public keys (read, and
//   update of every other field): a key-source collection, withholding the
//   per-row opt-in, the key text, the position, the parent and whatever
//   its key-source filter tests, and a collection such a filter reaches
//   through a relation, withholding the fields it tests there
//   (editor-policy-keys.ts); a new public key or a changed one stays an
//   administrator's decision;
// - read: a source editors must not write (moodle_users, owned by the
//   snapshot import) and the derived rows;
// - none: candidate, staging and status rows.
// The policy is code-owned: setup keeps the installed one equal to this.
// `keyed` defaults to the fields the declared key sources withhold.
export const grantClasses = ['edit', 'keyed', 'read', 'none'] as const;

export type GrantClass = (typeof grantClasses)[number];

type Keyed = ReadonlyMap<string, readonly string[]>;

export const grantClassOf = (
  declaration: CollectionDeclaration,
  keyed: Keyed = keyedFields,
): GrantClass => {
  if (!isSource(declaration)) {
    return forbiddenByRole[declaration.role].includes('read') ? 'none' : 'read';
  }
  if (declaration.editorWrites === false) {
    return 'read';
  }
  return keyed.has(declaration.collection) ? 'keyed' : 'edit';
};

export type PermissionSpec = {
  readonly action: PermissionAction;
  readonly collection: string;
  readonly fields: readonly string[];
  readonly permissions: Readonly<Record<string, unknown>>;
};

const every = ['*'] as const;

export const grant = (
  collection: string,
  action: PermissionAction,
  fields: readonly string[] = every,
): PermissionSpec => ({ action, collection, fields, permissions: {} });

// The writable fields of a keyed collection: its own fields and the
// relation aliases on it, less the fields that decide public keys.
const writableFields = (collection: string, keyed: Keyed): string[] => {
  const model = findModelCollection(collection);
  if (model === undefined) {
    return [];
  }
  const withheld = keyed.get(collection) ?? [];
  return [
    ...model.fields.map(({ field }) => field),
    ...aliasesFor(model.collection).map(({ alias }) => alias.field),
  ].filter((field) => !withheld.includes(field));
};

const grantsOf: Readonly<
  Record<
    GrantClass,
    (collection: string, keyed: Keyed) => readonly PermissionSpec[]
  >
> = {
  edit: (collection) => allActions.map((action) => grant(collection, action)),
  keyed: (collection, keyed) => {
    const fields = writableFields(collection, keyed);
    return [
      grant(collection, 'read'),
      ...(fields.length > 0 ? [grant(collection, 'update', fields)] : []),
    ];
  },
  none: () => [],
  read: (collection) => [grant(collection, 'read')],
};

// The editor grants on the model collections, in declaration order.
export const derivedGrants = (
  declarations: readonly CollectionDeclaration[] = collectionDeclarations,
  keyed: Keyed = keyedFields,
): readonly PermissionSpec[] =>
  declarations.flatMap((declaration) =>
    grantsOf[grantClassOf(declaration, keyed)](declaration.collection, keyed),
  );
