import { courses } from '../../directus/extensions/directus-extension-data-operations/src/exports/courses.js';
import {
  defaultMaxBytes,
  type ExportDefinition,
} from '../../directus/extensions/directus-extension-data-operations/src/exports/types.js';

// Two plain definitions the tests of the export engine run on, beside the
// real courses file.

// rooms.json: one row per room in id order with the seven public room
// fields; a floor or capacity of 0 is kept, an empty text is omitted.
// name, type and location are required: a consumer reads them on every
// row.
export const rooms: ExportDefinition = {
  fields: [
    { key: 'name', required: true, rule: 'text', value: 'name' },
    { key: 'type', required: true, rule: 'text', value: 'type' },
    { key: 'location', required: true, rule: 'text', value: 'location' },
    { key: 'description', rule: 'text', value: 'description' },
    { key: 'floor', rule: 'number', value: 'floor' },
    { key: 'capacity', rule: 'number', value: 'capacity' },
    { key: 'mrbs', rule: 'text', value: 'mrbs' },
  ],
  filename: 'rooms.json',
  maxBytes: defaultMaxBytes,
  orderBy: 'id',
  related: {},
  rows: {
    collection: 'rooms',
    fields: [
      'id',
      'name',
      'type',
      'location',
      'description',
      'floor',
      'capacity',
      'mrbs',
    ],
    sort: ['id'],
  },
};

// staff.json: one row per staff member in id order; `active` is published
// as "1"/"0", `courses` as its free text (never linked to course rows).
// name, title, position and email are required: a consumer reads them on
// every row.
export const staff: ExportDefinition = {
  fields: [
    { key: 'name', required: true, rule: 'text', value: 'name' },
    { key: 'active', rule: 'numeric_boolean', value: 'active' },
    { key: 'title', required: true, rule: 'text', value: 'title' },
    { key: 'position', required: true, rule: 'text', value: 'position' },
    { key: 'email', required: true, rule: 'text', value: 'email' },
    { key: 'cabinet', rule: 'text', value: 'cabinet' },
    { key: 'profile', rule: 'text', value: 'profile' },
    { key: 'courses', rule: 'text', value: 'courses' },
    { key: 'consultations', rule: 'text', value: 'consultations' },
  ],
  filename: 'staff.json',
  maxBytes: defaultMaxBytes,
  orderBy: 'id',
  related: {},
  rows: {
    collection: 'staff',
    fields: [
      'id',
      'name',
      'active',
      'title',
      'position',
      'email',
      'cabinet',
      'profile',
      'courses',
      'consultations',
    ],
    sort: ['id'],
  },
};

export const engineDefinitions: readonly ExportDefinition[] = [
  courses,
  rooms,
  staff,
];
