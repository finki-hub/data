import type { KeySource } from '../directus/extensions/directus-extension-data-operations/src/exports/types.js';

import {
  keySources,
  optInField,
} from '../directus/extensions/directus-extension-data-operations/src/exports/key-sources.js';
import { findModelRelation } from './data-model/relations.js';

// The fields that decide the public keys, derived from the key-source
// declarations (follow-up 58): an editor reads them but never writes them,
// so a new public key or a changed one stays an administrator's decision.
// A field a key-source filter tests through a relation is withheld in the
// related collection, which is then keyed as well.

type KeyedField = {
  readonly collection: string;
  readonly field: string;
};

// The field paths a filter tests: [field] for a field of the filtered
// collection, [m2o, ..., field] through relations. Logical groups and
// quantifiers (_and, _or, _some, _none) are read through; the operand of
// a comparison adds no path.
export const filterPaths = (filter: unknown): string[][] => {
  if (Array.isArray(filter)) {
    return filter.flatMap(filterPaths);
  }
  if (filter === null || typeof filter !== 'object') {
    return [];
  }
  return Object.entries(filter).flatMap(([key, value]) => {
    if (key.startsWith('_')) {
      return filterPaths(value);
    }
    const nested = filterPaths(value);
    return nested.length === 0 ? [[key]] : nested.map((path) => [key, ...path]);
  });
};

// Every field a path passes: each M2O step and the field it ends in, each
// in its own collection. A step that is no M2O relation of the model
// cannot be followed, so the derivation refuses it instead of withholding
// less than the filter reads.
const pathFields = (
  collection: string,
  path: readonly string[],
): KeyedField[] => {
  const [field, ...rest] = path;
  if (field === undefined) {
    return [];
  }
  if (rest.length === 0) {
    return [{ collection, field }];
  }
  const relation = findModelRelation(collection, field);
  if (relation === undefined) {
    throw new Error(
      `A key-source filter on ${collection} tests ${path.join('.')}, but ${field} is no M2O relation of the model, so the editor policy cannot withhold what it reads.`,
    );
  }
  return [{ collection, field }, ...pathFields(relation.related, rest)];
};

const distinct = (fields: readonly KeyedField[]): KeyedField[] =>
  fields.filter(
    (candidate, index) =>
      fields.findIndex(
        ({ collection, field }) =>
          collection === candidate.collection && field === candidate.field,
      ) === index,
  );

// Every field a key source reads to place its keys, once: the per-row
// opt-in, the key text, the position, the parent, and each field its
// filter tests (through a relation, in the related collection).
export const keySourceFields = (source: KeySource): KeyedField[] =>
  distinct([
    ...[
      optInField,
      source.key,
      source.position.field,
      ...(source.parent === undefined ? [] : [source.parent]),
    ].map((field) => ({ collection: source.collection, field })),
    ...filterPaths(source.filter).flatMap((path) =>
      pathFields(source.collection, path),
    ),
  ]);

// The fields editors may not write, per collection, merged over the key
// sources in first-seen order.
export const keyedFieldsOf = (
  sources: readonly KeySource[],
): ReadonlyMap<string, readonly string[]> => {
  const keyed = new Map<string, string[]>();
  for (const { collection, field } of sources.flatMap(keySourceFields)) {
    const fields = keyed.get(collection) ?? [];
    keyed.set(collection, fields.includes(field) ? fields : [...fields, field]);
  }
  return keyed;
};

export const keyedFields = keyedFieldsOf(Object.values(keySources));
