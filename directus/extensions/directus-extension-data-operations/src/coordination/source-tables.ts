import type { Domain } from './domains.js';

import {
  collectionDeclarations,
  sourceDeclarations,
} from './collection-roles.js';

// Views of the collection-role registry, the one declaration the
// source-invalidation migration is generated from.

// Which domains a statement on each editable source table marks pending.
export const sourceTableDomains: Readonly<Record<string, readonly Domain[]>> =
  Object.fromEntries(
    sourceDeclarations.map(({ collection, invalidates }) => [
      collection,
      invalidates,
    ]),
  );

// Domains a DELETE or TRUNCATE on a source table marks on top of its usual
// ones (deleting a history entry cascades its memberships away).
export const sourceTableDeletionDomains: Readonly<
  Record<string, readonly Domain[]>
> = Object.fromEntries(
  sourceDeclarations.flatMap(({ collection, onDelete }) =>
    onDelete === undefined ? [] : [[collection, onDelete]],
  ),
);

// Domains an UPDATE naming one of these columns marks on top of the
// table's usual ones (a hand-edited entry label).
export const sourceColumnDomains: Readonly<
  Record<string, Readonly<Record<string, readonly Domain[]>>>
> = Object.fromEntries(
  sourceDeclarations.flatMap(({ collection, columns }) =>
    columns === undefined
      ? []
      : [
          [
            collection,
            Object.fromEntries(
              Object.entries(columns).map(([column, { domains }]) => [
                column,
                domains,
              ]),
            ),
          ],
        ],
  ),
);

// Checkpoint tables a later cleanup may remove; their triggers are
// installed only while the table exists.
export const optionalSourceTables: readonly string[] = sourceDeclarations
  .filter(({ optional }) => optional === true)
  .map(({ collection }) => collection);

// Every model collection that is no source and so carries no trigger.
export const excludedTables: readonly string[] = collectionDeclarations
  .filter(({ role }) => role !== 'source')
  .map(({ collection }) => collection);
