import { findModelCollection } from '../collections.js';
import { toAliasPayload, toFieldPayload } from '../field-payloads.js';
import { aliasesFor } from '../relations.js';

// Meta columns Directus reports when an installer payload leaves them unset.
const metaDefaults: Readonly<Record<string, unknown>> = {
  conditions: null,
  display: null,
  display_options: null,
  group: null,
  hidden: false,
  note: null,
  options: null,
  special: null,
  translations: null,
  validation: null,
};

// The meta the schema installer wrote for a model field or alias: the
// reference the once-only rule compares the live meta against.
export const baselineFieldMeta = (
  collection: string,
  field: string,
): Readonly<Record<string, unknown>> => {
  const model = findModelCollection(collection);
  if (model === undefined) {
    throw new Error(`Collection ${collection} is not part of the model`);
  }
  const column = model.fields.find((candidate) => candidate.field === field);
  if (column !== undefined) {
    const columnSort = model.fields.indexOf(column) + 1;
    return { ...metaDefaults, ...toFieldPayload(column, columnSort).meta };
  }
  const aliases = aliasesFor(model.collection);
  const alias = aliases.find((candidate) => candidate.alias.field === field);
  if (alias === undefined) {
    throw new Error(`Field ${collection}.${field} is not part of the model`);
  }
  const aliasSort = model.fields.length + aliases.indexOf(alias) + 1;
  return { ...metaDefaults, ...toAliasPayload(alias.alias, aliasSort).meta };
};

export const baselineOptions = (
  collection: string,
  field: string,
): Readonly<Record<string, unknown>> => {
  const options = baselineFieldMeta(collection, field)['options'];
  return typeof options === 'object' && options !== null ? { ...options } : {};
};
