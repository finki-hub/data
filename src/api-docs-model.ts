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

// The notes the reference shows in place of a field's Studio note, which
// is written for editing: what the value means to a reader of the API.
const imported = 'When the data was last imported from the faculty.';
const thesisDocument = 'The id of the thesis document, when it has one.';
const thesisStaffName = 'The staff member as the thesis names them.';
export const docsNotes: Readonly<Record<string, string>> = {
  'bachelor_theses.file_id': thesisDocument,
  'bachelor_theses.imported_at': imported,
  'bachelor_thesis_staff.name': thesisStaffName,
  'courses.status':
    'active, all_professors (taught by all professors, listed as "Сите професори") or inactive (not offered, listed as "(неактивиран предмет)").',
  'curriculum_entries.channel':
    'Whether the subject gets a channel on the FINKI Hub Discord server, as the courses.json channel key.',
  'institutes.imported_at': imported,
  'master_theses.file_id': thesisDocument,
  'master_theses.imported_at': imported,
  'master_thesis_staff.name': thesisStaffName,
  'staff.finki':
    'False for staff of other faculties, visiting professors and external collaborators.',
  'timetables.checked_at':
    "When an import last found the timetable on the faculty's timetable site.",
};

const noteOf = (
  collection: string,
  field: string,
  studioNote: string | undefined,
) => {
  const note = docsNotes[`${collection}.${field}`] ?? studioNote;
  return note === undefined ? {} : { note };
};

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
      ...noteOf(collection, field.field, field.note),
      ...(field.kind === 'm2o' && { related: related(field.related, false) }),
    });
  }

  for (const { alias, relation } of aliases) {
    fields.set(alias.field, {
      label: fieldLabel(alias.field, alias.label),
      ...noteOf(collection, alias.field, alias.note),
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
