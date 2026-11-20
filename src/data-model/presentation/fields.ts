import type { FieldPresentation } from './types.js';

import { dataModelCollections } from '../collections.js';
import { type AliasDeclaration, aliasesFor } from '../relations.js';
import { baselineOptions } from './baseline.js';
import { curriculumFieldPresentations } from './curriculum-fields.js';
import { fieldGroups } from './groups.js';
import { moodleFieldPresentations } from './moodle-fields.js';

export const fieldPresentations: readonly FieldPresentation[] = [
  ...curriculumFieldPresentations,
  {
    collection: 'course_curricula',
    field: 'available',
    meta: {
      display: 'boolean',
      display_options: { labelOff: 'Not available', labelOn: 'Available' },
    },
  },
  { collection: 'teaching_assignments', field: 'sort', meta: { hidden: true } },
  // Bookkeeping of the imports, never read in Studio.
  { collection: 'timetables', field: 'fingerprint', meta: { hidden: true } },
  {
    collection: 'course_enrollments',
    field: 'computed_revision',
    meta: { hidden: true },
  },
  // Moodle profile fields that are almost always empty (old messengers)
  // or the same for everyone (the timezone); the scraper still fills them.
  ...['AIM', 'ICQ', 'MSN', 'MoodleNet', 'Skype', 'Timezone', 'Yahoo'].flatMap(
    (name) =>
      ['new', 'old'].map((instance) => ({
        collection: 'moodle_users',
        field: `${name}_${instance}`,
        meta: { hidden: true },
      })),
  ),
  // A channel's list picks existing courses; it never creates one (the
  // junction lists already create no related row).
  {
    collection: 'discord_channels',
    field: 'courses',
    meta: { options: { enableCreate: false } },
  },
  ...moodleFieldPresentations,
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

// Later metas win key by key; interface options are merged the same way.
const merge = (
  presentations: readonly FieldPresentation[],
): readonly FieldPresentation[] => {
  const byField = new Map<string, FieldPresentation>();
  for (const { collection, field, meta } of presentations) {
    const key = `${collection}.${field}`;
    const earlier = byField.get(key)?.meta;
    const options =
      earlier?.options === undefined || meta.options === undefined
        ? {}
        : { options: { ...earlier.options, ...meta.options } };
    byField.set(key, {
      collection,
      field,
      meta: { ...earlier, ...meta, ...options },
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
