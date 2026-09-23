import { defaultMaxBytes, type ExportDefinition } from './types.js';

// rooms.json: one row per room in id order with the seven public room
// fields; a floor or capacity of 0 is kept, an empty text is omitted.
export const rooms: ExportDefinition = {
  checks: [],
  fields: [
    { key: 'name', rule: 'text', value: 'name' },
    { key: 'type', rule: 'text', value: 'type' },
    { key: 'location', rule: 'text', value: 'location' },
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
