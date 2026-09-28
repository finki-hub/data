import type { Filter } from '@directus/types';

import type { IssueCounts, KeySourceName, ReadinessCheck } from './types.js';

import { keySourcesOf } from './field-map.js';
import { exportDefinitions } from './index.js';
import { keySources, optInField } from './key-sources.js';
import {
  generationField,
  type ReadinessEntry,
  type ReviewView,
} from './readiness-types.js';
import { sourceRows } from './values.js';

// The order blockers of the key sources, derived from their declarations
// (key-sources.ts). A source places each row's keys by the row's position,
// so a keyed row without one, or two siblings sharing one, would move
// public keys silently (the engine falls back to the key text). Every key
// source a definition places gets both blockers once, gating the files
// that place it and linking the source's collection; a new key source
// declares its position and needs nothing here. A row without a position
// gets a Needs review view of exactly those rows; shared positions link
// the collection, whose default view lists the rows by position.

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

// The keyed rows without a position, with their parent, key text, title,
// position and opt-in flag (a study program shows its generation and
// name, never a column per program).
const unsortedView = (name: KeySourceName, filter: Filter): ReviewView => {
  const { key, parent, position, title } = keySources[name];
  const placed = parent === undefined ? [] : [parent];
  return {
    bookmark: `Published ${position.row.replaceAll('_', ' ')}s without a ${position.field}`,
    fields: [
      ...placed,
      key,
      ...(title === undefined ? [] : [title]),
      position.field,
      optInField,
    ],
    filter,
    sort: [...placed, key],
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
  const unsorted = within(name, { [field]: { _null: true } });
  const entry: Pick<
    ReadinessEntry,
    'gates' | 'generationScoped' | 'page' | 'severity'
  > = {
    gates,
    // A program's rows carry the generation they belong to.
    generationScoped: parent === generationField,
    page: collection,
    severity: 'blocker',
  };
  return [
    {
      ...entry,
      code: `${row}_unsorted`,
      description: `A published ${noun} has no ${field}, so its keys have no place in ${files}. Give it a ${field}.`,
      review: unsortedView(name, unsorted),
      source: {
        aggregate: 'count',
        field: 'id',
        filter: unsorted,
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
