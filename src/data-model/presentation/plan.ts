import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import type { PresetDefinition } from './preset-schema.js';

import { baselineFieldMeta } from './baseline.js';
import { presentationFieldPatches } from './fields.js';
import { fieldGroups } from './groups.js';
import { collectionPlacements, folders } from './navigation.js';
import { presetDefinitions } from './presets.js';
import {
  type CollectionPlacement,
  type FieldGroup,
  type FieldPresentation,
  type Folder,
  type PresentationSummary,
  PresentationTally,
} from './types.js';

export const liveCollectionsSchema = z.array(
  z.object({
    collection: z.string(),
    meta: z.looseObject({ group: z.string().nullable().optional() }).nullable(),
    schema: z.unknown().nullable(),
  }),
);

export const liveFieldsSchema = z.array(
  z.object({
    field: z.string(),
    meta: z.record(z.string(), z.unknown()).nullable(),
    type: z.string().nullable(),
  }),
);

export const livePresetsSchema = z.array(
  z.object({
    bookmark: z.string().nullable(),
    collection: z.string().nullable(),
    role: z.string().nullable(),
    user: z.string().nullable(),
  }),
);

type LiveCollection = z.infer<typeof liveCollectionsSchema>[number];
export type LiveField = z.infer<typeof liveFieldsSchema>[number];
type LivePreset = z.infer<typeof livePresetsSchema>[number];

export type PresentationState = {
  readonly collections: ReadonlyMap<string, LiveCollection>;
  readonly fields: ReadonlyMap<string, readonly LiveField[]>;
  readonly presets: readonly LivePreset[];
};

type PresentationPlan = {
  readonly fields: readonly FieldPresentation[];
  readonly folders: readonly Folder[];
  readonly groups: readonly FieldGroup[];
  readonly placements: readonly CollectionPlacement[];
  readonly presets: readonly PresetDefinition[];
  readonly summary: PresentationSummary;
};

type GroupStatus = 'blocked' | 'create' | 'present';

const isGroupAlias = (field: LiveField): boolean =>
  field.type === 'alias' &&
  Array.isArray(field.meta?.['special']) &&
  field.meta['special'].includes('group');

// A declared group is created when its name is free, reused when a group
// alias already carries it, and blocked by any other field of that name.
const statusOf = (existing: LiveField | undefined): GroupStatus => {
  if (existing === undefined) {
    return 'create';
  }
  return isGroupAlias(existing) ? 'present' : 'blocked';
};

// Once-only rule for a field: every key the patch writes must still hold
// the value the schema installer wrote (Directus defaults for keys it never
// set). A key already changed, by an earlier presentation run or by a Studio
// user, leaves the whole field untouched.
const untouchedSinceInstall = (
  live: Readonly<Record<string, unknown>>,
  patch: FieldPresentation,
): boolean => {
  const baseline = baselineFieldMeta(patch.collection, patch.field);
  return Object.keys(patch.meta).every((key) =>
    isDeepStrictEqual(live[key] ?? null, baseline[key] ?? null),
  );
};

const groupStatuses = (
  state: PresentationState,
): ReadonlyMap<string, GroupStatus> =>
  new Map(
    fieldGroups.map((group) => [
      `${group.collection}.${group.field}`,
      statusOf(
        state.fields
          .get(group.collection)
          ?.find(({ field }) => field === group.field),
      ),
    ]),
  );

const planFields = (
  state: PresentationState,
  statuses: ReadonlyMap<string, GroupStatus>,
  tally: PresentationTally,
): readonly FieldPresentation[] =>
  presentationFieldPatches.filter((patch) => {
    const live = state.fields
      .get(patch.collection)
      ?.find(({ field }) => field === patch.field);
    const groupStatus =
      patch.meta.group === undefined
        ? 'present'
        : statuses.get(`${patch.collection}.${patch.meta.group}`);
    const applies =
      live?.meta !== null &&
      live?.meta !== undefined &&
      groupStatus !== 'blocked' &&
      untouchedSinceInstall(live.meta, patch);
    tally.add('fields', applies ? 'adopted' : 'skipped');
    return applies;
  });

const planGroups = (
  statuses: ReadonlyMap<string, GroupStatus>,
  fields: readonly FieldPresentation[],
  tally: PresentationTally,
): readonly FieldGroup[] =>
  fieldGroups.filter((group) => {
    const create =
      statuses.get(`${group.collection}.${group.field}`) === 'create' &&
      fields.some(
        (patch) =>
          patch.collection === group.collection &&
          patch.meta.group === group.field,
      );
    tally.add('groups', create ? 'created' : 'skipped');
    return create;
  });

// Whether a live preset is the global one (no user, no role) of a
// declared preset's collection and bookmark name (null for a default view).
export const isGlobalPreset = (
  live: LivePreset,
  preset: Pick<PresetDefinition, 'bookmark' | 'collection'>,
): boolean =>
  live.collection === preset.collection &&
  live.bookmark === preset.bookmark &&
  live.user === null &&
  live.role === null;

const planPresets = (
  state: PresentationState,
  tally: PresentationTally,
): readonly PresetDefinition[] =>
  presetDefinitions.filter((preset) => {
    const collection = state.collections.get(preset.collection);
    const create =
      collection !== undefined &&
      collection.schema !== null &&
      state.presets.every((live) => !isGlobalPreset(live, preset));
    tally.add('presets', create ? 'created' : 'skipped');
    return create;
  });

// Diffs the declared presentation against the live listings. Everything is
// additive and applied at most once per element; nothing is deleted. A
// preset (default view or bookmark) is created only while no global
// preset of its collection and name exists, so a view declared later is
// created on the next setup and an edited one is kept.
export const planPresentation = (
  state: PresentationState,
): PresentationPlan => {
  const tally = new PresentationTally();
  const newFolders = folders.filter((folder) => {
    const create = !state.collections.has(folder.collection);
    tally.add('collections', create ? 'created' : 'skipped');
    return create;
  });
  const placements = collectionPlacements.filter((placement) => {
    const live = state.collections.get(placement.collection);
    const place =
      live !== undefined &&
      live.schema !== null &&
      (live.meta?.group ?? null) === null;
    tally.add('collections', place ? 'adopted' : 'skipped');
    return place;
  });
  const statuses = groupStatuses(state);
  const fields = planFields(state, statuses, tally);
  return {
    fields,
    folders: newFolders,
    groups: planGroups(statuses, fields, tally),
    placements,
    presets: planPresets(state, tally),
    summary: tally.summary(),
  };
};
