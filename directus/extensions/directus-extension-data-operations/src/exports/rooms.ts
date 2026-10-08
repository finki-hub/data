import { defaultMaxBytes, type ExportDefinition } from './types.js';

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
