import { deriveCourses, deriveStudentCouncil } from './derive.js';

const sourceCollections = [
  'course_enrollment_patterns',
  'course_equivalencies',
  'courses',
  'curriculum_2018',
  'curriculum_2023',
  'moodle_users',
  'student_council',
  'students',
  'teaching_assignments',
];

const operation = {
  handler: async (_options, { database, getSchema, services }) => {
    const schema = await getSchema({ database });
    const service = (collection) =>
      new services.ItemsService(collection, {
        accountability: null,
        knex: database,
        schema,
      });
    const collections = Object.fromEntries(
      sourceCollections.map((collection) => [collection, service(collection)]),
    );
    const rows = Object.fromEntries(
      await Promise.all(
        sourceCollections.map(async (collection) => [
          collection,
          await collections[collection].readByQuery({
            fields: ['*'],
            limit: -1,
            sort: ['id'],
          }),
        ]),
      ),
    );

    const courseUpdates = await deriveCourses({
      courseEnrollmentPatterns: rows.course_enrollment_patterns,
      courseEquivalencies: rows.course_equivalencies,
      courses: rows.courses,
      curriculum2018: rows.curriculum_2018,
      curriculum2023: rows.curriculum_2023,
      moodleUsers: rows.moodle_users,
      teachingAssignments: rows.teaching_assignments,
    });
    const councilUpdates = deriveStudentCouncil({
      members: rows.student_council,
      students: rows.students,
    });

    if (courseUpdates.length > 0) {
      await collections.courses.updateBatch(courseUpdates, {
        emitEvents: false,
      });
    }
    if (councilUpdates.length > 0) {
      await collections.student_council.updateBatch(councilUpdates, {
        emitEvents: false,
      });
    }

    return {
      courses: courseUpdates.length,
      studentCouncilMembers: councilUpdates.length,
    };
  },
  id: 'finki-hub-rebuild-derived-data',
};

export default operation;
