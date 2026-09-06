import { describe, expect, test } from 'vitest';

import {
  deriveCourses,
  DerivedDataError,
  deriveStudentCouncil,
} from '../directus/extensions/directus-extension-rebuild-derived-data/derive.js';

const courseOne = 'Course One';

describe('derived Directus data', () => {
  test('rebuilds course lookups and enrollment counts from source collections', async () => {
    const result = await deriveCourses({
      courseEquivalencies: [
        { course_2018: 'Legacy Course', course_2023: courseOne },
      ],
      courseEnrollmentPatterns: [
        {
          academic_year: '2025/2026',
          course_name: courseOne,
          pattern: `${courseOne}-2025/2026|${courseOne} Honors-2025/2026`,
        },
      ],
      courses: [
        {
          id: 1,
          name: courseOne,
          name_2023: courseOne,
          professors_override: null,
        },
        {
          id: 2,
          name: 'Course Two',
          name_2018_override: 'Manual Legacy Course',
          name_2023: 'Course Two',
          professors_override: 'Manual Professor',
        },
      ],
      curriculum2018: [
        {
          channel: false,
          code: 'LEGACY-1',
          level: 1,
          name: 'Legacy Course',
          prerequisites: null,
          semester: 2,
          state_kn: 'mandatory',
        },
        {
          channel: true,
          code: 'LEGACY-2',
          level: 2,
          name: 'Manual Legacy Course',
          prerequisites: 'LEGACY-1',
          semester: 4,
        },
      ],
      curriculum2023: [
        {
          channel: true,
          code: 'CURRENT-1',
          level: 1,
          name: courseOne,
          prerequisites: null,
          semester: 1,
          state_kn: 'mandatory',
        },
        {
          channel: false,
          code: 'CURRENT-2',
          level: 2,
          name: 'Course Two',
          prerequisites: 'CURRENT-1',
          semester: 3,
        },
      ],
      moodleUsers: [
        {
          Courses: `${courseOne}-2025/2026, ${courseOne} Honors-2025/2026, Course Two-2024/2025`,
        },
        { Courses: `${courseOne} Honors-2025/2026` },
        { Courses: null },
      ],
      teachingAssignments: [
        {
          assistants: 'Assistant One',
          course_name: courseOne,
          professors: 'Professor One',
        },
        {
          assistants: 'Assistant Two',
          course_name: 'Course Two',
          professors: 'Ignored Professor',
        },
      ],
    });

    expect(result[0]).toMatchObject({
      assistants: 'Assistant One',
      channel: true,
      channel_2018: false,
      channel_2023: true,
      code_2018: 'LEGACY-1',
      code_2023: 'CURRENT-1',
      enrollment_2024_2025: 0,
      enrollment_2025_2026: 2,
      id: 1,
      name_2018: 'Legacy Course',
      professors: 'Professor One',
    });
    expect(result[1]).toMatchObject({
      assistants: 'Assistant Two',
      channel: true,
      code_2018: 'LEGACY-2',
      code_2023: 'CURRENT-2',
      enrollment_2024_2025: 1,
      enrollment_2025_2026: 0,
      id: 2,
      name_2018: 'Manual Legacy Course',
      professors: 'Manual Professor',
    });
  });

  test('uses the first spreadsheet-style lookup match', async () => {
    const [result] = await deriveCourses({
      courseEquivalencies: [],
      courseEnrollmentPatterns: [],
      courses: [
        {
          id: 1,
          name: courseOne,
          name_2023: courseOne,
          professors_override: null,
        },
      ],
      curriculum2018: [],
      curriculum2023: [],
      moodleUsers: [],
      teachingAssignments: [
        { course_name: courseOne, professors: 'First Professor' },
        { course_name: courseOne, professors: 'Second Professor' },
      ],
    });

    expect(result?.['professors']).toBe('First Professor');
  });

  test('yields to the Directus event loop while calculating courses', async () => {
    let eventLoopYielded = false;
    setImmediate(() => {
      eventLoopYielded = true;
    });

    await deriveCourses({
      courseEnrollmentPatterns: [],
      courseEquivalencies: [],
      courses: [
        {
          id: 1,
          name: courseOne,
          name_2023: courseOne,
          professors_override: null,
        },
      ],
      curriculum2018: [],
      curriculum2023: [],
      moodleUsers: [],
      teachingAssignments: [],
    });

    expect(eventLoopYielded).toBeTruthy();
  });

  test('derives student council names from the student directory', () => {
    expect(
      deriveStudentCouncil({
        members: [
          { id: 1, index_number: 'S-001' },
          { id: 2, index_number: 'S-404' },
        ],
        students: [
          { index_number: 'S-001', name: 'Student One' },
          { index_number: 'S-001', name: 'Duplicate Student' },
        ],
      }),
    ).toEqual([
      { id: 1, name: 'Student One' },
      { id: 2, name: null },
    ]);
  });
});

describe('enrollment history matching', () => {
  test('counts LF and CRLF separated histories with the default name-year pattern', async () => {
    const [result] = await deriveCourses({
      courseEnrollmentPatterns: [],
      courseEquivalencies: [],
      courses: [
        {
          id: 1,
          name: courseOne,
          name_2023: courseOne,
          professors_override: null,
        },
      ],
      curriculum2018: [],
      curriculum2023: [],
      moodleUsers: [
        { Courses: `Other Course-2025/2026\n${courseOne}-2025/2026` },
        { Courses: `Other Course-2025/2026\r\n${courseOne}-2025/2026` },
        { Courses: `${courseOne}-2024/2025\r\n` },
      ],
      teachingAssignments: [],
    });

    expect(result).toMatchObject({
      enrollment_2024_2025: 1,
      enrollment_2025_2026: 2,
    });
  });

  test('counts a user once when the history repeats a matching entry', async () => {
    const [result] = await deriveCourses({
      courseEnrollmentPatterns: [],
      courseEquivalencies: [],
      courses: [
        {
          id: 1,
          name: courseOne,
          name_2023: courseOne,
          professors_override: null,
        },
      ],
      curriculum2018: [],
      curriculum2023: [],
      moodleUsers: [
        { Courses: `${courseOne}-2025/2026\n${courseOne}-2025/2026` },
      ],
      teachingAssignments: [],
    });

    expect(result?.['enrollment_2025_2026']).toBe(1);
  });

  test('applies a pattern override only to its own academic year', async () => {
    const [result] = await deriveCourses({
      courseEnrollmentPatterns: [
        {
          academic_year: '2025/2026',
          course_name: courseOne,
          pattern: `${courseOne} Honors-2025/2026`,
        },
      ],
      courseEquivalencies: [],
      courses: [
        {
          id: 1,
          name: courseOne,
          name_2023: courseOne,
          professors_override: null,
        },
      ],
      curriculum2018: [],
      curriculum2023: [],
      moodleUsers: [
        { Courses: `${courseOne}-2025/2026\n${courseOne}-2024/2025` },
      ],
      teachingAssignments: [],
    });

    expect(result).toMatchObject({
      enrollment_2024_2025: 1,
      enrollment_2025_2026: 0,
    });
  });

  test('rejects a course name that is not a valid regular expression', async () => {
    await expect(
      deriveCourses({
        courseEnrollmentPatterns: [],
        courseEquivalencies: [],
        courses: [
          { id: 1, name: 'C++', name_2023: null, professors_override: null },
        ],
        curriculum2018: [],
        curriculum2023: [],
        moodleUsers: [],
        teachingAssignments: [],
      }),
    ).rejects.toThrow(DerivedDataError);
  });
});
