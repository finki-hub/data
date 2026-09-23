import { defineHook } from '@directus/extensions-sdk';

import { coordinationError } from './coordination/errors.js';

export const membershipCollection = 'moodle_history_memberships';

export const membershipEvents = ['create', 'update', 'delete'] as const;

// The refusal every Directus write to the derived history index gets.
export const derivedIndexRefusal = () =>
  coordinationError(
    'DERIVED_INDEX',
    'moodle_history_memberships is the derived Moodle history index; only the history index run writes it. Edit the raw Courses history of the Moodle user, or the entry and its mappings; the scheduled "Data / Process pending" Flow rebuilds the index.',
    { status: 403 },
  );

// Refuses every item write on the memberships through Directus (Studio,
// REST, GraphQL, Flows that emit events) with a readable 403 before any
// statement runs. The index writer uses its own transaction and never goes
// through the items service; the database guard of the schema-constraints
// migration refuses everything else, and foreign key cascades from a
// deleted Moodle user or entry never reach these filters.
export const registerMembershipGuard = (
  filter: (event: string, handler: () => never) => void,
): void => {
  for (const event of membershipEvents) {
    filter(`${membershipCollection}.items.${event}`, () => {
      throw derivedIndexRefusal();
    });
  }
};

export default defineHook(({ filter }) => {
  registerMembershipGuard(filter);
});
