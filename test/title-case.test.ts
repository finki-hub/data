import { describe, expect, test } from 'vitest';

import { titleCase } from '../src/data-model/title-case.js';
import {
  collectionTranslations,
  fieldTranslations,
} from '../src/data-model/translations.js';

describe('Studio names in Title Case', () => {
  test.each([
    ['Moodle course links', 'Moodle Course Links'],
    ['Timetables & rooms', 'Timetables & Rooms'],
    ['Duration (years)', 'Duration (Years)'],
    ['Name (old)', 'Name (Old)'],
    ['ECTS credits', 'ECTS Credits'],
    ['Dean’s office', 'Dean’s Office'],
    ['Read-only state', 'Read-only State'],
    ['already Title Case', 'Already Title Case'],
    ['Предмет на студиите', 'Предмет На Студиите'],
  ])('writes %s as %s', (label, expected) => {
    expect(titleCase(label)).toBe(expected);
  });

  test('applies to the translations of fields, aliases, groups and collections', () => {
    expect(fieldTranslations('Only in year')).toEqual([
      { language: 'en-US', translation: 'Only In Year' },
    ]);
    expect(
      collectionTranslations({
        plural: 'Program courses',
        singular: 'Program course',
      }),
    ).toEqual([
      {
        language: 'en-US',
        plural: 'Program Courses',
        singular: 'Program Course',
        translation: 'Program Courses',
      },
    ]);
  });
});
