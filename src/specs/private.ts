import {
  type SnapshotField,
  type SnapshotFieldDeclaration,
  snapshotFieldTable,
} from '../../directus/extensions/directus-extension-data-operations/src/snapshot/contract.js';
import { type FieldSpec, type WorkbookSpec } from '../schema.js';

// The workbook's Courses sheet, the first Moodle users snapshot: a fixed
// historical export, so its columns never grow. It carries these scraper
// fields, whose kinds come from the snapshot contract. The fields only the
// scraper fills (ID_old, Profile_old, Timezone_new, Timezone_old) and any
// scraper field added later are not among them; the import leaves those
// columns empty.
const sheetFields: ReadonlySet<SnapshotField> = new Set([
  'AIM_new',
  'AIM_old',
  'Avatar_new',
  'Avatar_old',
  'City_new',
  'City_old',
  'Country_new',
  'Country_old',
  'Courses',
  'Courses Count',
  'Description_new',
  'Description_old',
  'ICQ_new',
  'ICQ_old',
  'ID_new',
  'Images_new',
  'Images_old',
  'Interests_new',
  'Interests_old',
  'Last Access_new',
  'Last Access_old',
  'Mail',
  'MoodleNet_new',
  'MoodleNet_old',
  'MSN_new',
  'MSN_old',
  'Name',
  'Profile_new',
  'Skype_new',
  'Skype_old',
  'Web_new',
  'Web_old',
  'Yahoo_new',
  'Yahoo_old',
]);

// The sheet's headers that differ from the field names.
const renamedHeaders: Readonly<Partial<Record<SnapshotField, string>>> = {
  'Courses Count': '#',
  ID_new: 'ID',
  Profile_new: 'Profile',
};

const sheetField = ({
  field,
  kind,
  required,
}: SnapshotFieldDeclaration & {
  readonly field: SnapshotField;
}): FieldSpec => ({
  kind,
  ...(required !== undefined && { required }),
  source: renamedHeaders[field] ?? field,
  target: field,
});

export const privateWorkbookSpecs = [
  {
    fields: snapshotFieldTable
      .filter(({ field }) => sheetFields.has(field))
      .map(sheetField),
    key: 'moodle_users',
    source: { kind: 'rows', sheet: 'Courses' },
  },
] as const satisfies readonly WorkbookSpec[];
