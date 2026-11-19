import courseSearch from '../../../directus/presets/course-search.json' with { type: 'json' };
import {
  type PresetDefinition,
  presetSchema,
  type TabularPreset,
  tabularPresetSchema,
} from './preset-schema.js';

// The permanent shared bookmarks: setup installs each once by collection
// and name, and a rerun keeps an existing one as Studio left it. The
// incomplete-data bookmarks come from the import
// (src/import/incomplete-data-bookmarks.ts).

// The history lines the last completed count counted for no course and
// year: a plain O2M null on the counted lines, newest First seen first,
// so the new lines of a later snapshot are at the top.
export const unmappedLinesBookmark: TabularPreset = tabularPresetSchema.parse({
  bookmark: 'Unmapped Moodle Courses',
  collection: 'moodle_course_entries',
  filter: { counted_for: { id: { _null: true } } },
  icon: 'link_off',
  layout: 'tabular',
  layout_options: { tabular: { spacing: 'comfortable' } },
  layout_query: {
    tabular: {
      fields: ['label', 'first_seen'],
      limit: 50,
      page: 1,
      sort: ['-first_seen', 'label'],
    },
  },
  role: null,
  search: null,
  user: null,
});

// The shared Search bookmark on the Moodle users, declared in
// directus/presets/course-search.json.
export const searchBookmark: PresetDefinition =
  presetSchema.parse(courseSearch);
