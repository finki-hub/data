import { describe, expect, test } from 'vitest';

import { toFieldPayload } from '../src/data-model/field-payloads.js';
import { findCollection, findField } from './data-model-test-helpers.js';

// The columns the public files need on every row: a curriculum link's
// availability is never empty, and the staff and room values a consumer
// reads on every published row are required.

const requiredOf = (collection: string): readonly string[] =>
  findCollection(collection)
    .fields.filter(({ nullable }) => !nullable)
    .map(({ field }) => field);

describe('required columns of the published rows', () => {
  test('keeps a curriculum link available or not, never empty, and starts a new link available', () => {
    const available = findField('course_curricula', 'available');

    expect(available).toMatchObject({
      defaultValue: true,
      kind: 'boolean',
      nullable: false,
    });
    expect(toFieldPayload(available, 4)).toMatchObject({
      meta: { required: true },
      schema: { default_value: true, is_nullable: false },
      type: 'boolean',
    });
  });

  test('requires the staff and room values a consumer reads on every row', () => {
    expect(requiredOf('staff')).toEqual([
      'name',
      'active',
      // Not published; whether FINKI employs them (true unless set).
      'finki',
      'title',
      'position',
      'email',
      // Not published by hand; the import's council flag (false unless set).
      'council_member',
    ]);
    expect(requiredOf('rooms')).toEqual(['name', 'type', 'location']);
  });

  test.each([
    ['staff', 'title'],
    ['staff', 'position'],
    ['staff', 'email'],
    ['rooms', 'type'],
  ] as const)(
    'declares %s.%s required in its field payload',
    (collection, field) => {
      expect(toFieldPayload(findField(collection, field), 1)).toMatchObject({
        meta: { required: true },
        schema: { is_nullable: false },
        type: 'string',
      });
    },
  );
});
