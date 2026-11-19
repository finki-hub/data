import type { DirectusRequest } from '../directus-request.js';
import type { FieldGroup, Folder } from './presentation/types.js';

import { presentationFieldPatches } from './presentation/fields.js';
import { fieldGroups } from './presentation/groups.js';
import {
  liveCollectionsSchema,
  type LiveField,
  liveFieldsSchema,
  livePresetsSchema,
  planPresentation,
  type PresentationState,
} from './presentation/plan.js';
import { fieldTranslations } from './translations.js';

const json = (body: unknown, method: 'PATCH' | 'POST') => ({
  body: JSON.stringify(body),
  method,
});

// Every preset with what tells a global one from a personal one.
export const presetsQuery =
  '/presets?limit=-1&fields=bookmark,collection,user,role';

// Collections whose fields the presentation touches.
const presentedCollections: readonly string[] = [
  ...new Set([
    ...fieldGroups.map(({ collection }) => collection),
    ...presentationFieldPatches.map(({ collection }) => collection),
  ]),
];

// A folder is a `directus_collections` row without a table: no `schema`.
// Its label is its only text: it sends no note.
const folderPayload = (folder: Folder) => ({
  collection: folder.collection,
  meta: {
    collapse: folder.collapse,
    hidden: false,
    icon: folder.icon,
    sort: folder.sort,
    translations: fieldTranslations(folder.label),
  },
});

// A group is an alias field flagged `group`; its members point at it. Its
// label is the section heading.
const groupPayload = (group: FieldGroup) => ({
  field: group.field,
  meta: {
    hidden: false,
    interface: 'group-detail',
    ...(group.note !== undefined && { note: group.note }),
    options: { headerIcon: group.headerIcon, start: group.start },
    readonly: group.readOnly === true,
    required: false,
    sort: group.sort,
    special: ['alias', 'no-data', 'group'],
    translations: fieldTranslations(group.label),
    width: 'full',
  },
  schema: null,
  type: 'alias',
});

const readState = async (
  request: DirectusRequest,
): Promise<PresentationState> => {
  const collections = liveCollectionsSchema.parse(
    await request('/collections'),
  );
  const known = new Map(
    collections.map((collection) => [collection.collection, collection]),
  );
  const fields = new Map<string, readonly LiveField[]>();
  for (const collection of presentedCollections) {
    const existing = known.get(collection);
    if (existing === undefined || existing.schema === null) {
      continue;
    }
    fields.set(
      collection,
      liveFieldsSchema.parse(await request(`/fields/${collection}`)),
    );
  }
  const presets = livePresetsSchema.parse(await request(presetsQuery));
  return { collections: known, fields, presets };
};

// Installs the Studio presentation once: sidebar folders and placement,
// form groups, relational interface options, displays and shared presets
// (the default views, Search and Unmapped Moodle Courses; only the import
// creates the incomplete-data bookmarks). Each element is written only
// while it still carries the schema installer's defaults, so a rerun never
// overwrites Studio edits and a project that already has the presentation
// sees no mutating call.
export const installPresentation = async (request: DirectusRequest) => {
  const plan = planPresentation(await readState(request));
  for (const folder of plan.folders) {
    await request('/collections', json(folderPayload(folder), 'POST'));
  }
  for (const placement of plan.placements) {
    await request(
      `/collections/${placement.collection}`,
      json({ meta: placement.meta }, 'PATCH'),
    );
  }
  for (const group of plan.groups) {
    await request(
      `/fields/${group.collection}`,
      json(groupPayload(group), 'POST'),
    );
  }
  for (const patch of plan.fields) {
    await request(
      `/fields/${patch.collection}/${encodeURIComponent(patch.field)}`,
      json({ meta: patch.meta }, 'PATCH'),
    );
  }
  for (const preset of plan.presets) {
    await request('/presets', json(preset, 'POST'));
  }
  return plan.summary;
};
