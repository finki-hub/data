import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

export const academicYears = [
  '2025/2026',
  '2024/2025',
  '2023/2024',
  '2022/2023',
  '2021/2022',
  '2020/2021',
  '2019/2020',
  '2018/2019',
  '2017/2018',
  '2016/2017',
  '2015/2016',
  '2014/2015',
  '2013/2014',
  '2012/2013',
  '2011/2012',
];

export class DerivedDataError extends Error {
  name = 'DerivedDataError';
}

const firstBy = (rows, field) => {
  const result = new Map();
  for (const row of rows) {
    const value = row[field];
    if (typeof value === 'string' && !result.has(value)) {
      result.set(value, row);
    }
  }

  return result;
};

const nullable = (value) =>
  value === undefined || value === '' ? null : value;

const nonEmptyString = (value) =>
  typeof value === 'string' && value !== '' ? value : null;

const requiredString = (row, field, label) => {
  const value = nonEmptyString(row[field]);
  if (value === null) {
    throw new DerivedDataError(`${label} is missing ${field}`);
  }

  return value;
};

const requiredId = (row, label) => {
  const id = row.id;
  if (typeof id !== 'number' && typeof id !== 'string') {
    throw new DerivedDataError(`${label} is missing its primary key`);
  }

  return id;
};

const enrollmentPatternKey = (courseName, academicYear) =>
  `${courseName}\u{0}${academicYear}`;

const buildEnrollmentPatterns = (rows) => {
  const patterns = new Map();
  for (const row of rows) {
    const courseName = requiredString(row, 'course_name', 'Enrollment pattern');
    const academicYear = requiredString(
      row,
      'academic_year',
      'Enrollment pattern',
    );
    const pattern = requiredString(row, 'pattern', 'Enrollment pattern');
    patterns.set(enrollmentPatternKey(courseName, academicYear), pattern);
  }

  return patterns;
};

const countEnrollment = ({
  academicYear,
  courseName,
  courseTexts,
  pattern,
}) => {
  let matcher;
  try {
    matcher = new RegExp(pattern ?? `${courseName}-${academicYear}`, 'u');
  } catch (error) {
    throw new DerivedDataError(
      `Invalid enrollment pattern for ${courseName} in ${academicYear}`,
      { cause: error },
    );
  }

  let count = 0;
  for (const courses of courseTexts) {
    if (matcher.test(courses)) {
      count += 1;
    }
  }

  return count;
};

const curriculumValues = (curriculum, suffix, stateFields) => {
  const values = {
    [`channel_${suffix}`]: nullable(curriculum?.channel),
    [`code_${suffix}`]: nullable(curriculum?.code),
    [`level_${suffix}`]: nullable(curriculum?.level),
    [`prerequisite_${suffix}`]: nullable(curriculum?.prerequisites),
    [`semester_${suffix}`]: nullable(curriculum?.semester),
  };
  for (const state of stateFields) {
    values[`state_${state}_${suffix}`] = nullable(
      curriculum?.[`state_${state}`],
    );
  }

  return values;
};

export const deriveCourses = async ({
  courseEnrollmentPatterns,
  courseEquivalencies,
  courses,
  curriculum2018,
  curriculum2023,
  moodleUsers,
  teachingAssignments,
}) => {
  const assignmentsByCourse = firstBy(teachingAssignments, 'course_name');
  const currentByName = firstBy(curriculum2023, 'name');
  const equivalenciesByCourse = firstBy(courseEquivalencies, 'course_2023');
  const legacyByName = firstBy(curriculum2018, 'name');
  const patterns = buildEnrollmentPatterns(courseEnrollmentPatterns);
  const courseTexts = moodleUsers.flatMap((user) =>
    typeof user.Courses === 'string' ? [user.Courses] : [],
  );

  const updates = [];
  for (const course of courses) {
    await yieldToEventLoop();
    const id = requiredId(course, 'Course');
    const name = requiredString(course, 'name', `Course ${String(id)}`);
    const assignment = assignmentsByCourse.get(name);
    const currentName = nonEmptyString(course.name_2023);
    const current =
      currentName === null ? undefined : currentByName.get(currentName);
    const equivalency = equivalenciesByCourse.get(name);
    const legacyName =
      nonEmptyString(course.name_2018_override) ??
      nonEmptyString(equivalency?.course_2018);
    const legacy =
      legacyName === null ? undefined : legacyByName.get(legacyName);
    const enrollmentValues = Object.fromEntries(
      academicYears.map((year) => [
        `enrollment_${year.replace('/', '_')}`,
        countEnrollment({
          academicYear: year,
          courseName: name,
          courseTexts,
          pattern: patterns.get(enrollmentPatternKey(name, year)),
        }),
      ]),
    );

    updates.push({
      assistants: nullable(assignment?.assistants),
      channel: Boolean(current?.channel || legacy?.channel),
      id,
      ...curriculumValues(current, '2023', [
        'kn',
        'siis',
        'pit',
        'imb',
        'ki',
        'ie',
        'ssp',
        'seis',
      ]),
      ...curriculumValues(legacy, '2018', [
        'kn',
        'siis',
        'pit',
        'imb',
        'ki',
        'ke',
        'seis',
      ]),
      ...enrollmentValues,
      name_2018: legacyName,
      professors:
        nonEmptyString(course.professors_override) ??
        nullable(assignment?.professors),
    });
  }

  return updates;
};

export const deriveStudentCouncil = ({ members, students }) => {
  const studentsByIndex = firstBy(students, 'index_number');

  return members.map((member) => {
    const id = requiredId(member, 'Student council member');
    const indexNumber = requiredString(
      member,
      'index_number',
      `Student council member ${String(id)}`,
    );

    return { id, name: nullable(studentsByIndex.get(indexNumber)?.name) };
  });
};
