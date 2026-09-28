import { z } from 'zod';

import { findModelCollection } from '../collections.js';

// The shape of the shared presets the presentation installs, and the
// default table view every browsed collection gets.

const tabularQuerySchema = z.object({
  fields: z.array(z.string()).min(1),
  limit: z.number().int().positive(),
  page: z.number().int().positive(),
  sort: z.array(z.string()).min(1),
});

// The `POST /presets` body of a shared preset: `bookmark` names a shared
// bookmark, null makes the preset the collection default; `filter` is one
// filter object.
const sharedPreset = {
  bookmark: z.string().nullable(),
  collection: z.string(),
  filter: z.record(z.string(), z.unknown()).nullable(),
  icon: z.string(),
  role: z.null(),
  search: z.null(),
  user: z.null(),
};

// A table view: its columns, order and page size.
export const tabularPresetSchema = z.object({
  ...sharedPreset,
  layout: z.literal('tabular'),
  layout_options: z.object({
    tabular: z.object({ spacing: z.enum(['comfortable', 'compact', 'cozy']) }),
  }),
  layout_query: z.object({ tabular: tabularQuerySchema }),
});

export type TabularPreset = z.infer<typeof tabularPresetSchema>;

// The course-history layout of the course-search extension, which keeps
// no options or query of its own.
const searchPresetSchema = z.object({
  ...sharedPreset,
  layout: z.literal('finki-hub-course-search'),
  layout_options: z.strictObject({}),
  layout_query: z.strictObject({}),
});

export const presetSchema = z.discriminatedUnion('layout', [
  tabularPresetSchema,
  searchPresetSchema,
]);

export type PresetDefinition = z.infer<typeof presetSchema>;

// A collection's default table view: the columns, their order, 25 rows
// per page and the collection's icon.
export const defaultView = (
  collection: string,
  fields: readonly string[],
  sort: readonly string[],
): TabularPreset => ({
  bookmark: null,
  collection,
  filter: null,
  icon: findModelCollection(collection)?.icon ?? 'table_view',
  layout: 'tabular',
  layout_options: { tabular: { spacing: 'comfortable' } },
  layout_query: {
    tabular: { fields: [...fields], limit: 25, page: 1, sort: [...sort] },
  },
  role: null,
  search: null,
  user: null,
});
