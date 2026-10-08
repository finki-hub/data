import {
  instanceIdFields,
  type SnapshotFieldDeclaration,
  snapshotFieldTable,
} from '../../directus/extensions/directus-extension-data-operations/src/snapshot/contract.js';
import { type FieldSpec, type WorkbookSpec } from '../schema.js';

const idFields: ReadonlySet<string> = new Set(instanceIdFields);

// The workbook's Courses sheet, the first Moodle users snapshot: the
// scraper's profiles.csv imported into Google Sheets. It carries every
// field of the snapshot contract under its own header, each read with the
// contract's kind; ID_old and ID_new follow the snapshot import's id rule
// (kind `id`).
const sheetField = ({
  field,
  kind,
  required,
}: SnapshotFieldDeclaration): FieldSpec => ({
  kind: idFields.has(field) ? 'id' : kind,
  ...(required !== undefined && { required }),
  source: field,
  target: field,
});

export const privateWorkbookSpecs = [
  {
    fields: snapshotFieldTable.map(sheetField),
    key: 'moodle_users',
    source: { kind: 'rows', sheet: 'Courses' },
  },
] as const satisfies readonly WorkbookSpec[];
