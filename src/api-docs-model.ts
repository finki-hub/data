import type {
  ApiDocsCollection,
  ApiDocsField,
  ApiDocsModel,
} from '../directus/extensions/directus-extension-data-operations/src/api-docs.js';

import { publicReads } from './data-model/access.js';
import { dataModelCollections } from './data-model/collections.js';
import { aliasesFor } from './data-model/relations.js';
import { titleCase } from './data-model/title-case.js';

// What the public API reference (/docs) shows of the model: the Studio
// names of every public collection and, for each public field, its label,
// note and the collection a relation points to. `npm run
// generate:api-docs` writes it beside the docs endpoint, and
// test/api-docs.test.ts fails while the snapshot is stale.

const findCollection = (collection: string) =>
  dataModelCollections.find((model) => model.collection === collection);

// A field without a declared label is named as Studio names it: its key,
// words capitalized.
const fieldLabel = (field: string, label: string | undefined) =>
  titleCase(label ?? field.replaceAll('_', ' '));

const pluralOf = (collection: string) => {
  const model = findCollection(collection);
  return titleCase(model?.label?.plural ?? collection.replaceAll('_', ' '));
};

const singularOf = (collection: string) => {
  const model = findCollection(collection);
  return titleCase(model?.label?.singular ?? collection.replaceAll('_', ' '));
};

// A relation's target: one related item by its singular name, a list by
// its plural.
const related = (collection: string, many: boolean) => ({
  collection,
  label: many ? pluralOf(collection) : singularOf(collection),
  many,
});

const collectionModel = (
  collection: string,
  readable: '*' | readonly string[],
): ApiDocsCollection => {
  const model = findCollection(collection);
  const modelFields = model?.fields ?? [];
  const aliases = model === undefined ? [] : aliasesFor(model.collection);
  const fields = new Map<string, ApiDocsField>();

  for (const field of modelFields) {
    fields.set(field.field, {
      label: fieldLabel(field.field, field.label),
      ...(field.note !== undefined && { note: field.note }),
      ...(field.kind === 'm2o' && { related: related(field.related, false) }),
    });
  }

  for (const { alias, relation } of aliases) {
    fields.set(alias.field, {
      label: fieldLabel(alias.field, alias.label),
      ...(alias.note !== undefined && { note: alias.note }),
      related: related(relation.collection, true),
    });
  }

  return {
    fields: Object.fromEntries(
      [...fields].filter(
        ([field]) => readable === '*' || readable.includes(field),
      ),
    ),
    plural: pluralOf(collection),
    singular: singularOf(collection),
  };
};

const collator = new Intl.Collator('en');

export const buildApiDocsModel = (): ApiDocsModel => ({
  collections: Object.fromEntries(
    publicReads
      .map(
        ({ collection, fields }) =>
          [collection, collectionModel(collection, fields)] as const,
      )
      .toSorted(([left], [right]) => collator.compare(left, right)),
  ),
});

export const apiDocsModelPath =
  'directus/extensions/directus-extension-data-operations/src/api-docs-model.json';

export const serializeApiDocsModel = (model: ApiDocsModel) =>
  `${JSON.stringify(model, null, 2)}\n`;
