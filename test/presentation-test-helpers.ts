import { baselineFieldMeta } from '../src/data-model/presentation/baseline.js';
import { findFieldPatch } from '../src/data-model/presentation/fields.js';
import { fieldGroups } from '../src/data-model/presentation/groups.js';
import {
  collectionPlacements,
  folders,
} from '../src/data-model/presentation/navigation.js';
import { presetDefinitions } from '../src/data-model/presentation/presets.js';
import { type FakeState, installedState } from './data-model-test-helpers.js';

// The Studio meta a field carries once the schema installer and then the
// presentation installer have both run on a fresh project.
export const effectiveFieldMeta = (
  collection: string,
  field: string,
): Readonly<Record<string, unknown>> => ({
  ...baselineFieldMeta(collection, field),
  ...findFieldPatch(collection, field)?.meta,
});

// A freshly installed schema with no preset at all: what `npm run setup`
// finds right after the data model and its constraints went in.
export const freshState = (): FakeState => ({
  ...installedState(),
  presets: [],
});

const placeCollections = (state: FakeState): void => {
  for (const folder of folders) {
    state.collections.push({
      collection: folder.collection,
      meta: { group: null, hidden: false },
      schema: null,
    });
  }
  for (const placement of collectionPlacements) {
    const collection = state.collections.find(
      (candidate) => candidate.collection === placement.collection,
    );
    if (collection !== undefined) {
      collection.meta = { ...collection.meta, ...placement.meta };
    }
  }
};

const addGroups = (state: FakeState): void => {
  for (const group of fieldGroups) {
    state.fields[group.collection]?.push({
      field: group.field,
      meta: {
        group: null,
        interface: 'group-detail',
        special: ['alias', 'no-data', 'group'],
      },
      schema: null,
      type: 'alias',
    });
  }
};

const patchFields = (state: FakeState): void => {
  for (const [collection, fields] of Object.entries(state.fields)) {
    for (const field of fields) {
      const patch = findFieldPatch(collection, field.field);
      if (patch !== undefined && field.meta !== null) {
        field.meta = { ...field.meta, ...patch.meta };
      }
    }
  }
};

// The listings a project reports after one full presentation run, derived
// from the declarations themselves so a second run must find nothing to do.
export const appliedState = (): FakeState => {
  const state = freshState();
  placeCollections(state);
  addGroups(state);
  patchFields(state);
  state.presets = presetDefinitions.map(({ bookmark, collection }) => ({
    bookmark,
    collection,
    role: null,
    user: null,
  }));
  return state;
};
