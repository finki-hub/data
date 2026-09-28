import type { Filter } from '@directus/types';

import { filled } from './text-filters.js';

// The curriculum check of courses.json, as a plain filter: whether a text
// column holds a label is a filter, never a read value.

// An equivalency member label of a generation with a curriculum that
// names no entry of it.
export const unlinkedMember: Filter = {
  _and: [
    filled('label'),
    { entry: { _null: true } },
    { generation: { has_curriculum: { _eq: true } } },
  ],
};
