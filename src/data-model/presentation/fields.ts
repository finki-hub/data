import type { FieldCondition, FieldPresentation } from './types.js';

import { curriculumEntryTemplate } from '../checkpoint-collections.js';
import { dataModelCollections, findModelCollection } from '../collections.js';
import { toAliasPayload, toFieldPayload } from '../field-payloads.js';
import { type AliasDeclaration, aliasesFor } from '../relations.js';
import { fieldGroups } from './groups.js';

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

const baselineOptions = (
  collection: string,
  field: string,
): Readonly<Record<string, unknown>> => {
  const options = baselineFieldMeta(collection, field)['options'];
  return typeof options === 'object' && options !== null ? { ...options } : {};
};

// Dropdown choices in the order the model declares them, with a label each.
const choices = (
  collection: string,
  field: string,
  labels: Readonly<Record<string, string>>,
) => {
  const column = findModelCollection(collection)?.fields.find(
    (candidate) => candidate.field === field,
  );
  if (column?.kind !== 'enum') {
    throw new Error(`Field ${collection}.${field} is not an enum`);
  }
  return column.choices.map((value) => ({
    text: labels[value] ?? value,
    value,
  }));
};

const labelled = (
  collection: string,
  field: string,
  labels: Readonly<Record<string, string>>,
): FieldPresentation => ({
  collection,
  field,
  meta: {
    display: 'labels',
    display_options: {
      choices: choices(collection, field, labels),
      showAsDot: false,
    },
    options: {
      ...baselineOptions(collection, field),
      choices: choices(collection, field, labels),
    },
  },
});

// Rendered by Studio with the link row's own live `generation` value before
// the entry picker queries, so only entries of that generation are offered.
// The database trigger from the schema constraints rejects the rest.
export const generationFilter = { generation: { _eq: '{{ generation }}' } };

// A new link row carries `generation: null`, so the entry selector stays
// locked until a generation is chosen; opened earlier, Studio would query
// the entries with an empty generation and get an invalid-query error back.
export const entryLockedWithoutGeneration: FieldCondition = {
  name: 'Generation not chosen yet',
  readonly: true,
  rule: { generation: { _null: true } },
};

export const fieldPresentations: readonly FieldPresentation[] = [
  {
    collection: 'course_curricula',
    field: 'entry',
    meta: {
      conditions: [entryLockedWithoutGeneration],
      note: 'Pick the generation first: the picker lists only entries of that generation.',
      options: {
        ...baselineOptions('course_curricula', 'entry'),
        filter: generationFilter,
        template: curriculumEntryTemplate,
      },
      sort: 3,
    },
  },
  // The generation comes before the entry it filters.
  { collection: 'course_curricula', field: 'generation', meta: { sort: 2 } },
  {
    collection: 'course_curricula',
    field: 'available',
    meta: {
      display: 'boolean',
      display_options: { labelOff: 'Not available', labelOn: 'Available' },
    },
  },
  { collection: 'course_curricula', field: 'sort', meta: { hidden: true } },
  labelled('teaching_assignments', 'role', {
    assistant: 'Assistant',
    professor: 'Professor',
  }),
  { collection: 'teaching_assignments', field: 'sort', meta: { hidden: true } },
  {
    collection: 'teaching_assignments',
    field: 'course_name',
    meta: {
      note: 'Course label the checkpoint derivation still reads, so it stays required: type the course name until the derivation follows the course link.',
      sort: 12,
      width: 'full',
    },
  },
  // The copied name stays visible read-only: council rows keep it as their
  // only label until every student link is backfilled.
  {
    collection: 'student_council',
    field: 'name',
    meta: {
      note: 'Copied council name, kept read-only; the linked student record is the source of truth.',
      readonly: true,
    },
  },
  labelled('moodle_course_entries', 'review_state', {
    ignored: 'Ignored',
    mapped: 'Mapped',
    needs_mapping: 'Needs mapping',
  }),
  labelled('course_enrollment_rules', 'mode', {
    legacy_regex: 'Legacy regex',
    mapped_entries: 'Mapped entries',
  }),
];

// The columns of a relation list. An editable list ordered by a sort field
// drops that raw column: its drag handle already shows the order.
const listColumns = ({
  alias,
  relation,
}: AliasDeclaration): readonly string[] =>
  alias.readOnly === true || relation.sortField === null
    ? alias.fields
    : alias.fields.filter((field) => field !== relation.sortField);

// Every relation list gets a search box; lists whose relation carries a
// sort field are ordered by it.
const listPresentations = (): readonly FieldPresentation[] =>
  dataModelCollections.flatMap(({ collection }) =>
    aliasesFor(collection).map((declaration) => ({
      collection,
      field: declaration.alias.field,
      meta: {
        options: {
          ...baselineOptions(collection, declaration.alias.field),
          enableSearchFilter: true,
          fields: listColumns(declaration),
          ...(declaration.relation.sortField !== null && {
            sort: declaration.relation.sortField,
            sortDirection: '+',
          }),
        },
      },
    })),
  );

const membershipPresentations = (): readonly FieldPresentation[] =>
  fieldGroups.flatMap((group) =>
    group.members.map((field, index) => ({
      collection: group.collection,
      field,
      meta: { group: group.field, sort: index + 1 },
    })),
  );

const merge = (
  presentations: readonly FieldPresentation[],
): readonly FieldPresentation[] => {
  const byField = new Map<string, FieldPresentation>();
  for (const { collection, field, meta } of presentations) {
    const key = `${collection}.${field}`;
    byField.set(key, {
      collection,
      field,
      meta: { ...byField.get(key)?.meta, ...meta },
    });
  }
  return byField.values().toArray();
};

// One PATCH body per field: explicit presentation, list options and group
// membership merged.
export const presentationFieldPatches: readonly FieldPresentation[] = merge([
  ...listPresentations(),
  ...fieldPresentations,
  ...membershipPresentations(),
]);

export const findFieldPatch = (
  collection: string,
  field: string,
): FieldPresentation | undefined =>
  presentationFieldPatches.find(
    (patch) => patch.collection === collection && patch.field === field,
  );
