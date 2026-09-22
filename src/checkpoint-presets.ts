import { z } from 'zod';

import type { DirectusRequest } from './directus-request.js';
import type { CollectionSpec } from './schema.js';

import courseSearch from '../directus/presets/course-search.json' with { type: 'json' };
import { collectionSpecs } from './model.js';

const livePresets = z.array(
  z.object({
    bookmark: z.string().nullable(),
    collection: z.string().nullable(),
    role: z.string().nullable(),
    user: z.string().nullable(),
  }),
);

type PresetBody = {
  readonly body: Readonly<Record<string, unknown>>;
  readonly bookmark: null | string;
  readonly collection: string;
};

export type PresetInstallSummary = {
  readonly created: number;
  readonly skipped: number;
};

// The table view the checkpoint importer gave every checkpoint collection:
// its preview columns, sorted by its preview field.
export const checkpointPreset = (spec: CollectionSpec): PresetBody => ({
  body: {
    collection: spec.key,
    layout: 'tabular',
    layout_options: { tabular: { spacing: 'comfortable' } },
    layout_query: {
      tabular: { fields: spec.previewFields, sort: [spec.previewSort] },
    },
  },
  bookmark: null,
  collection: spec.key,
});

// The shared Search bookmark of the course-history layout.
export const searchBookmark: PresetBody = {
  body: courseSearch,
  bookmark: courseSearch.bookmark,
  collection: courseSearch.collection,
};

// Installs the checkpoint table views and the Search bookmark once: a
// global preset for the same collection and bookmark (a default view when
// the bookmark is null) is never replaced, whoever created it, so the
// relational default views the presentation installed first and every
// view a populated deployment's importer or Studio created stay as they
// are. Only the missing ones are created.
export const installCheckpointPresets = async (
  request: DirectusRequest,
): Promise<PresetInstallSummary> => {
  const live = livePresets.parse(
    await request('/presets?limit=-1&fields=bookmark,collection,user,role'),
  );
  const declared = [...collectionSpecs.map(checkpointPreset), searchBookmark];
  const missing = declared.filter((preset) =>
    live.every(
      (present) =>
        !(
          present.user === null &&
          present.role === null &&
          present.collection === preset.collection &&
          present.bookmark === preset.bookmark
        ),
    ),
  );
  for (const preset of missing) {
    await request('/presets', {
      body: JSON.stringify(preset.body),
      method: 'POST',
    });
  }
  return {
    created: missing.length,
    skipped: declared.length - missing.length,
  };
};
