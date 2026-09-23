import { defaultMaxBytes, type ExportDefinition } from './types.js';

// staff.json: one row per staff member in id order; `active` is published
// as "1"/"0", `courses` as its free text (never linked to course rows).
export const staff: ExportDefinition = {
  fields: [
    { key: 'name', rule: 'text', value: 'name' },
    { key: 'active', rule: 'numeric_boolean', value: 'active' },
    { key: 'title', rule: 'text', value: 'title' },
    { key: 'position', rule: 'text', value: 'position' },
    { key: 'email', rule: 'text', value: 'email' },
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
