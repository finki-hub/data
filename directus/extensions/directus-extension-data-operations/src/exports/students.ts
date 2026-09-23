import { defaultMaxBytes, type ExportDefinition } from './types.js';

// students.json: one row per student record in id order with the index
// and the name only. The private student directory's source_group is
// never read.
export const students: ExportDefinition = {
  checks: [],
  fields: [
    { key: 'index', rule: 'text', value: 'index_number' },
    { key: 'name', rule: 'text', value: 'name' },
  ],
  filename: 'students.json',
  maxBytes: defaultMaxBytes,
  orderBy: 'id',
  related: {},
  rows: {
    collection: 'students',
    fields: ['id', 'index_number', 'name'],
    sort: ['id'],
  },
};
