import { z } from 'zod';

import type { ReadinessEntry } from '../directus/extensions/directus-extension-data-operations/src/exports/readiness-types.js';

import { readinessRegistry } from '../directus/extensions/directus-extension-data-operations/src/exports/readiness-registry.js';
import { dataModelCollections } from '../src/data-model/collections.js';
import { baselineFieldMeta } from '../src/data-model/presentation/baseline.js';
import { findFieldPatch } from '../src/data-model/presentation/fields.js';
import { fieldGroups } from '../src/data-model/presentation/groups.js';
import {
  collectionPlacements,
  folders,
} from '../src/data-model/presentation/navigation.js';
import { presetDefinitions } from '../src/data-model/presentation/presets.js';
import { aliasesFor, modelRelations } from '../src/data-model/relations.js';
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

// The body of a preset POST that the review tests read.
const presetBody = z.object({
  bookmark: z.string().nullable(),
  collection: z.string(),
});

export const reviewBody = presetBody.extend({
  filter: z.record(z.string(), z.unknown()),
  layout_query: z.object({
    tabular: z.object({ fields: z.array(z.string()) }),
  }),
});

// A check only this test declares: generation-scoped, on the curriculum
// entries (whose records carry a generation), with one review view.
const extraCheck: ReadinessEntry = {
  code: 'synthetic_entry_without_code',
  description:
    'A synthetic check of the test: a curriculum entry without a code.',
  gates: [],
  generationScoped: true,
  page: 'curriculum_entries',
  review: {
    bookmark: 'Synthetic entries without a code',
    fields: ['generation', 'name', 'code'],
    filter: { code: { _null: true } },
    sort: ['generation', 'name'],
  },
  severity: 'warning',
  source: {
    aggregate: 'count',
    field: 'id',
    filter: { code: { _null: true } },
    kind: 'count',
  },
};

export const withExtraCheck: readonly ReadinessEntry[] = [
  ...readinessRegistry,
  extraCheck,
];

// The Needs review bookmarks the registry declares, as installed bodies.
export const reviewedBy = (registry: readonly ReadinessEntry[]) =>
  registry.flatMap(({ page, review }) =>
    review === undefined
      ? []
      : [
          {
            bookmark: review.bookmark,
            collection: page,
            fields: [...review.fields],
            filter: review.filter,
          },
        ],
  );

export const bookmarkNames = new Set(
  reviewedBy(withExtraCheck).map(({ bookmark }) => bookmark),
);

const descendingPrefix = /^-/u;

// The fields and aliases of a model collection (none for an unknown one).
const modelFieldNames = (collection: string): readonly string[] => {
  const model = dataModelCollections.find(
    (candidate) => candidate.collection === collection,
  );
  return model === undefined
    ? []
    : [
        ...model.fields.map(({ field }) => field),
        ...aliasesFor(model.collection).map(({ alias }) => alias.field),
      ];
};

// The collection an O2M alias of a model collection lists.
const aliasTarget = (collection: string, field: string): string | undefined => {
  const model = dataModelCollections.find(
    (candidate) => candidate.collection === collection,
  );
  return model === undefined
    ? undefined
    : aliasesFor(model.collection).find(({ alias }) => alias.field === field)
        ?.relation.collection;
};

// The collection a field leads to: its M2O target, or the collection an
// O2M alias lists.
const relatedCollection = (
  collection: string,
  field: string,
): string | undefined =>
  modelRelations.find(
    (relation) =>
      relation.collection === collection && relation.field === field,
  )?.related ?? aliasTarget(collection, field);

// Whether a tabular preset path such as `student.name` resolves in the
// model; `id`, the primary key of every collection, always does.
export const resolves = (collection: string, path: string): boolean => {
  const [head, ...rest] = path.replace(descendingPrefix, '').split('.');
  if (head === 'id' && rest.length === 0) {
    return true;
  }
  if (head === undefined || !modelFieldNames(collection).includes(head)) {
    return false;
  }
  if (rest.length === 0) {
    return true;
  }
  const related = relatedCollection(collection, head);
  return related !== undefined && resolves(related, rest.join('.'));
};
