import { describe, expect, test } from 'vitest';

import { collectionSpecs } from '../src/model.js';

const collectionIcon = (key: string): string | undefined =>
  collectionSpecs.find((spec) => spec.key === key)?.icon;

describe('collection icons', () => {
  test('uses the current curriculum icon for the 2018 curriculum', () => {
    expect(collectionIcon('curriculum_2018')).toBe('menu_book');
  });

  test('uses a single-person icon for Moodle users', () => {
    expect(collectionIcon('moodle_users')).toBe('person');
  });
});
