import { defineHook } from '@directus/extensions-sdk';

import {
  type GuardedDeclaration,
  guardedDeclarations,
} from './coordination/collection-roles.js';
import { coordinationError } from './coordination/errors.js';
import { guardMessage } from './coordination/write-guards.js';

export const guardedEvents = ['create', 'update', 'delete'] as const;

// The refusal every Directus item write to a guarded table gets.
const writeGuardRefusal = (declaration: GuardedDeclaration) =>
  coordinationError(
    'WRITE_GUARDED',
    `${guardMessage(declaration)}. ${declaration.guard.remedy}`,
    {
      details: {
        collection: declaration.collection,
        role: declaration.role,
      },
      status: 403,
    },
  );

// Refuses every item write on the derived, candidate and staging tables of
// the collection-role registry through Directus (Studio, REST, GraphQL,
// the native CSV/JSON import, Flows that emit events) with a readable 403
// before any statement runs. Their writers use raw SQL in their own
// transaction and never go through the items service; the database guard
// of the schema-constraints migration refuses everything else, and foreign
// key cascades never reach these filters.
export const registerWriteGuards = (
  filter: (event: string, handler: () => never) => void,
): void => {
  for (const declaration of guardedDeclarations) {
    for (const event of guardedEvents) {
      filter(`${declaration.collection}.items.${event}`, () => {
        throw writeGuardRefusal(declaration);
      });
    }
  }
};

export default defineHook(({ filter }) => {
  registerWriteGuards(filter);
});
