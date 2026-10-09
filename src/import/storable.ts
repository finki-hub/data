import type { ModelCollectionKey, ModelField } from '../schema.js';

import { patternMappingMaxBytes } from '../../directus/extensions/directus-extension-data-operations/src/migrations.js';
import { findModelCollection } from '../data-model/collections.js';
import { enumMaxLength } from '../data-model/field-payloads.js';
import {
  isRef,
  type Origin,
  type PlannedCollection,
  type PlannedRow,
  type PlannedValue,
} from './planned.js';

// A Directus string column is varchar(255), an enum column varchar(64);
// integers are PostgreSQL int4.
const maxStringLength = 255;
const minInteger = -2_147_483_648;
const maxInteger = 2_147_483_647;

// Characters as PostgreSQL counts them in a varchar: code points, so a
// surrogate pair is one character, not two UTF-16 units.
const characterCount = (value: string): number => {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    // The second half of a surrogate pair was counted with the first.
    const point = value.codePointAt(index) ?? 0;
    if (point < 0xdc_00 || point > 0xdf_ff) {
      count += 1;
    }
  }
  return count;
};

const tooLong = (value: string, limit: number): null | string => {
  const length = characterCount(value);
  return length > limit
    ? `${String(length)} characters, max ${String(limit)}`
    : null;
};

// The text columns a CHECK of the schema-constraints migration limits in
// bytes (PostgreSQL octet_length, UTF-8).
const textByteLimits: Partial<
  Record<ModelCollectionKey, Readonly<Record<string, number>>>
> = { moodle_pattern_mappings: patternMappingMaxBytes };

const encoder = new TextEncoder();

const tooManyBytes = (value: string, limit: number): null | string => {
  const length = encoder.encode(value).length;
  return length > limit
    ? `${String(length)} bytes, max ${String(limit)}`
    : null;
};

// Why the column of the field cannot hold the value, as a fact about the
// value, or null when it can.
const unstorable = (
  field: ModelField,
  value: PlannedValue,
  maxBytes: number | undefined,
): null | string => {
  if (value === null) {
    return field.nullable ? null : 'empty (required)';
  }
  if (isRef(value) || field.kind === 'm2o') {
    return null;
  }
  if (typeof value === 'string' && maxBytes !== undefined) {
    return tooManyBytes(value, maxBytes);
  }
  if (typeof value === 'string' && field.kind === 'string') {
    return tooLong(value, maxStringLength);
  }
  if (typeof value === 'string' && field.kind === 'enum') {
    return tooLong(value, enumMaxLength);
  }
  if (typeof value === 'number' && field.kind === 'integer') {
    return Number.isSafeInteger(value) &&
      value >= minInteger &&
      value <= maxInteger
      ? null
      : 'integer outside int4 range';
  }
  return null;
};

type Problem = { readonly field: string; readonly problem: string };

// Every column of a planned row that cannot hold what the row plans for
// it, with why: a required column the row leaves out (the database would
// fill it with nothing), or a value its column cannot hold.
const rowProblems = (
  collection: ModelCollectionKey,
  fields: ReadonlyMap<string, ModelField>,
  row: PlannedRow,
): readonly Problem[] => {
  const missing = fields
    .values()
    .filter(
      (field) =>
        !field.nullable &&
        (field.kind === 'm2o' || field.defaultValue === undefined) &&
        !Object.hasOwn(row.record, field.field),
    )
    .map(({ field }) => ({ field, problem: 'missing (required)' }))
    .toArray();
  const maxBytes = textByteLimits[collection] ?? {};
  const held = Object.entries(row.record).flatMap(([name, value]) => {
    const field = fields.get(name);
    if (field === undefined) {
      throw new TypeError(`plan: ${collection}.${name} not in model`);
    }
    const problem = unstorable(field, value, maxBytes[name]);
    return problem === null ? [] : [{ field: name, problem }];
  });
  return [...missing, ...held];
};

// A planned value its column cannot hold, or a required column its row
// leaves out: the collection and field, the planned row by its origin (its
// sheet and row) and plan key, and why, never the value.
export type UnstorableValue = Problem & {
  readonly collection: ModelCollectionKey;
  readonly key: string;
  readonly origin: null | Origin;
};

// Every planned value its column cannot hold, found before anything is
// written: the database would refuse that row partway through the import,
// after earlier rows were stored. A field the model does not declare is a
// bug in the plan.
export const unstorableValues = (
  collections: readonly PlannedCollection[],
): readonly UnstorableValue[] =>
  collections.flatMap(({ collection, rows }) => {
    const fields = new Map(
      (findModelCollection(collection)?.fields ?? []).map((field) => [
        field.field,
        field,
      ]),
    );
    return rows.flatMap((row) =>
      rowProblems(collection, fields, row).map((problem) => ({
        ...problem,
        collection,
        key: row.key,
        origin: row.origin,
      })),
    );
  });
