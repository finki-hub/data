import type { Filter } from '@directus/types';

import type { ReadinessEntry } from './readiness-types.js';
import type { IssueCounts, KeySourceName, ReadinessCheck } from './types.js';

import { keySourcesOf } from './field-map.js';
import { exportDefinitions } from './index.js';
import { keySources } from './key-sources.js';
import { sourceRows } from './values.js';

// The order blockers of the key sources, derived from their declarations
// (key-sources.ts). A source places each row's keys by the row's position,
// so a keyed row without one, or two siblings sharing one, would move
// public keys silently (the engine falls back to the key text). Every key
// source a definition places gets both blockers once, gating the files
// that place it and linking the source's collection; a new key source
// declares its position and needs nothing here.

// The rows the key source reads that also match `condition`.
const within = (name: KeySourceName, condition: Filter): Filter => {
  const { filter } = keySources[name];
  return filter === undefined ? condition : { _and: [filter, condition] };
};

// The keyed rows with a position, less their distinct places (the parent
// and the position): the rows that share their place with a sibling.
const sharedPlaces = (name: KeySourceName, code: string): ReadinessCheck => {
  const { collection, parent, position } = keySources[name];
  const place =
    parent === undefined ? [position.field] : [parent, position.field];
  return {
    evaluate: (sources): IssueCounts => {
      const places = sourceRows(sources, 'places').map((row) =>
        JSON.stringify(place.map((field) => row[field] ?? null)),
      );
      return { [code]: places.length - new Set(places).size };
    },
    reads: {
      places: {
        collection,
        fields: place,
        filter: within(name, { [position.field]: { _nnull: true } }),
        sort: place,
      },
    },
  };
};

// The files whose definitions place the key source.
const placingFiles = (name: KeySourceName): readonly string[] =>
  exportDefinitions
    .filter((definition) => keySourcesOf(definition).includes(name))
    .map(({ filename }) => filename);

const orderEntries = (name: KeySourceName): readonly ReadinessEntry[] => {
  const { collection, parent, position } = keySources[name];
  const { field, row } = position;
  const noun = row.replaceAll('_', ' ');
  const gates = placingFiles(name);
  const files = gates.join(', ');
  const shared = `${row}_sort_shared`;
  const sibling = parent === undefined ? '' : ` of its ${parent}`;
  const entry: Pick<
    ReadinessEntry,
    'gates' | 'generationScoped' | 'page' | 'severity'
  > = { gates, generationScoped: false, page: collection, severity: 'blocker' };
  return [
    {
      ...entry,
      code: `${row}_unsorted`,
      description: `A published ${noun} has no ${field}, so its keys have no place in ${files}. Give it a ${field}.`,
      source: {
        aggregate: 'count',
        field: 'id',
        filter: within(name, { [field]: { _null: true } }),
        kind: 'count',
      },
    },
    {
      ...entry,
      code: shared,
      description: `A published ${noun} shares its ${field} with another${sibling}, so their keys have no order in ${files}. Give each its own ${field}.`,
      source: { check: sharedPlaces(name, shared), kind: 'check' },
    },
  ];
};

// The order blockers of every key source the definitions place, each
// source once, in definition and field order.
export const keyOrderEntries: readonly ReadinessEntry[] = [
  ...new Set(
    exportDefinitions.flatMap((definition) => keySourcesOf(definition)),
  ),
].flatMap((name) => orderEntries(name));
