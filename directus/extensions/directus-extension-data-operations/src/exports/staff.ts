import { defaultMaxBytes, type ExportDefinition } from './types.js';

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
