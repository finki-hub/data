import ExcelJS from 'exceljs';
import { describe, expect, test } from 'vitest';

import { collectionSpecs } from '../src/model.js';
import {
  type CollectionSpec,
  derivedField,
  literalField,
  requiredField,
} from '../src/schema.js';
import { readCourseEnrollmentPatterns } from '../src/workbook-enrollment-reader.js';
import { readRows } from '../src/workbook-row-reader.js';

describe('workbook readers', () => {
  test('imports literal source cells without copying cached formula results', () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Synthetic courses');
    sheet.addRow(['name', 'professors']);
    sheet.addRow([
      'Course One',
      { formula: '"Derived Professor"', result: 'Derived Professor' },
    ]);
    sheet.addRow(['Course Two', 'Manual Professor']);
    const spec = {
      displayTemplate: '{{name}}',
      fields: [
        requiredField('name', 'name'),
        literalField('professors', 'professors_override', 'text'),
        derivedField('professors', 'text'),
      ],
      icon: 'school',
      key: 'courses',
      note: 'Synthetic test collection.',
      previewFields: ['name'],
      previewSort: 'name',
      sort: 1,
      source: { kind: 'rows', sheet: 'Synthetic courses' },
    } as const satisfies CollectionSpec;

    expect(readRows(workbook, spec, spec.source)).toEqual([
      { name: 'Course One', professors_override: null },
      { name: 'Course Two', professors_override: 'Manual Professor' },
    ]);
  });

  test('normalizes only literal listener pattern overrides', () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Synthetic listeners');
    sheet.addRow(['', '', '2025/2026', '', '2025/2026']);
    sheet.addRow(['Course One', '', '', '', 'Course One-2025/2026|Legacy']);
    sheet.addRow(['Course Two', '', '', '', '']);
    sheet.getRow(3).getCell(5).value = {
      formula: '$A3&"-"&C$1',
      result: 'Course Two-2025/2026',
    };

    expect(
      readCourseEnrollmentPatterns(workbook, {
        kind: 'course-enrollment-patterns',
        sheet: 'Synthetic listeners',
      }),
    ).toEqual([
      {
        academic_year: '2025/2026',
        course_name: 'Course One',
        pattern: 'Course One-2025/2026|Legacy',
      },
    ]);
  });

  test('models the longest staff profile URL without truncation', () => {
    const staff = collectionSpecs.find(({ key }) => key === 'staff');
    const profile = staff?.fields.find(({ target }) => target === 'profile');

    expect(profile?.kind).toBe('text');
  });

  test('does not store formula-only preview sheets as duplicate collections', () => {
    const sourceSheets = collectionSpecs.flatMap(({ source }) =>
      source.kind === 'rows' ? [source.sheet] : [],
    );

    expect(sourceSheets).not.toContain('Пребарување');
    expect(sourceSheets).not.toContain('Индекси');
  });

  test('marks spreadsheet outputs as derived Directus fields', () => {
    const courses = collectionSpecs.find(({ key }) => key === 'courses');
    const council = collectionSpecs.find(
      ({ key }) => key === 'student_council',
    );

    expect(
      courses?.fields.find(({ target }) => target === 'enrollment_2025_2026'),
    ).toMatchObject({ derived: true });
    expect(
      courses?.fields.find(({ target }) => target === 'professors_override'),
    ).toMatchObject({ sourceMode: 'literal' });
    expect(
      council?.fields.find(({ target }) => target === 'name'),
    ).toMatchObject({ derived: true });
  });

  test('uses the current courses-scraper CSV headers as Moodle field keys', () => {
    const moodleUsers = collectionSpecs.find(
      ({ key }) => key === 'moodle_users',
    );

    expect(moodleUsers?.fields.map(({ target }) => target)).toEqual([
      'ID_old',
      'ID_new',
      'Name',
      'Mail',
      'Courses',
      'Courses Count',
      'Profile_old',
      'Profile_new',
      'AIM_new',
      'AIM_old',
      'Avatar_new',
      'Avatar_old',
      'City_new',
      'City_old',
      'Country_new',
      'Country_old',
      'Description_new',
      'Description_old',
      'ICQ_new',
      'ICQ_old',
      'Images_new',
      'Images_old',
      'Interests_new',
      'Interests_old',
      'Last Access_new',
      'Last Access_old',
      'MSN_new',
      'MSN_old',
      'MoodleNet_new',
      'MoodleNet_old',
      'Skype_new',
      'Skype_old',
      'Timezone_new',
      'Timezone_old',
      'Web_new',
      'Web_old',
      'Yahoo_new',
      'Yahoo_old',
    ]);
  });
});
