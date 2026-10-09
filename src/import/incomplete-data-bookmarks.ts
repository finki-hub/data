import { z } from 'zod';

import type { ReadinessEntry } from '../../directus/extensions/directus-extension-data-operations/src/exports/readiness-types.js';
import type { DirectusRequest } from '../directus-request.js';

import { readinessRegistry } from '../../directus/extensions/directus-extension-data-operations/src/exports/readiness-registry.js';
import { findModelCollection } from '../data-model/collections.js';
import { presetsQuery } from '../data-model/presentation.js';
import {
  isGlobalPreset,
  livePresetsSchema,
} from '../data-model/presentation/plan.js';
import { tabularPresetSchema } from '../data-model/presentation/preset-schema.js';

// The incomplete-data bookmarks: one shared Studio bookmark per entry of
// the readiness-check registry that declares a review view, on its page
// collection (the collection whose records it counts), in registry order.
// Setup never creates them. The one-time import creates each whose view
// lists a row once every row is written, so a bookmark names data that is
// actually missing, and one deleted in Studio stays deleted. The dashboard
// links a check to its bookmark by the same page and name while it exists.
// A generation-scoped view is one bookmark that shows the generation, never
// one per generation row.

const bookmarkPresetSchema = tabularPresetSchema.extend({
  bookmark: z.string(),
  filter: z.record(z.string(), z.unknown()),
});

type BookmarkPreset = z.infer<typeof bookmarkPresetSchema>;

export const incompleteDataPresets = (
  registry: readonly ReadinessEntry[] = readinessRegistry,
): readonly BookmarkPreset[] =>
  registry.flatMap(({ page, review }) =>
    review === undefined
      ? []
      : [
          bookmarkPresetSchema.parse({
            bookmark: review.bookmark,
            collection: page,
            filter: review.filter,
            icon: review.icon ?? findModelCollection(page)?.icon ?? 'rule',
            layout: 'tabular',
            layout_options: { tabular: { spacing: 'comfortable' } },
            layout_query: {
              tabular: {
                fields: [...review.fields],
                limit: 50,
                page: 1,
                sort: [...review.sort],
              },
            },
            role: null,
            search: null,
            user: null,
          }),
        ],
  );

// The first row a view lists: its filter, one id.
const firstRowPath = ({ collection, filter }: BookmarkPreset): string =>
  `/items/${collection}?fields=id&limit=1&filter=${encodeURIComponent(JSON.stringify(filter))}`;

const rowsSchema = z.array(z.unknown());

// Creates each incomplete-data bookmark whose view lists a row, unless a
// global preset of its collection and name exists (a personal one does
// not count); answers the names created, in registry order.
export const createIncompleteDataBookmarks = async (
  request: DirectusRequest,
  registry: readonly ReadinessEntry[] = readinessRegistry,
): Promise<readonly string[]> => {
  const live = livePresetsSchema.parse(await request(presetsQuery));
  const created: string[] = [];
  for (const preset of incompleteDataPresets(registry)) {
    if (live.some((existing) => isGlobalPreset(existing, preset))) {
      continue;
    }
    const rows = rowsSchema.parse(await request(firstRowPath(preset)));
    if (rows.length > 0) {
      await request('/presets', {
        body: JSON.stringify(preset),
        method: 'POST',
      });
      created.push(preset.bookmark);
    }
  }
  return created;
};
