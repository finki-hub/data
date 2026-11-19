// The public API reference at /docs: the OpenAPI document Directus generates
// for anonymous callers, cut down to what they can use (reading the public
// collections), described and grouped by subject like the Studio sidebar,
// with the /legacy files added. This module imports nothing, so the docs
// endpoint and the tests read it.

export type DocsGroup = {
  readonly collections: Readonly<Record<string, string>>;
  readonly description: string;
  readonly name: string;
};

// Every public collection, once, by the Studio folder it sits in (the
// helper collections of Internals go with the subject they serve).
export const docsGroups: readonly DocsGroup[] = [
  {
    collections: {
      course_equivalencies:
        'Groups of equivalent subjects across accreditations.',
      course_equivalency_members:
        'The subjects of each equivalency group, one per accreditation.',
      courses:
        "Courses of the 2018 and 2023 accreditations and the master's programs: names in Macedonian and English, abbreviation, degree cycle, status and syllabus.",
    },
    description: 'The courses and how they relate across accreditations.',
    name: 'Courses',
  },
  {
    collections: {
      course_accreditation_staff:
        'The teachers each accreditation lists for a course.',
      course_teaching:
        'Who teaches each course in each main timetable, by role and periods, matched from the timetables.',
      teaching_assignments: 'Teaching staff of a course kept by hand.',
    },
    description: 'Who teaches a course, from each source.',
    name: 'Teaching',
  },
  {
    collections: {
      course_curricula:
        "A course's place in each accreditation: its subject, credits and whether it is offered.",
      curriculum_entries:
        'The subjects of each accreditation: code, semester, prerequisites and subject page.',
      curriculum_entry_program_states:
        'Whether a subject is mandatory or elective in each study program.',
      curriculum_generations: 'The accreditations (2013, 2018, 2023).',
      study_programs: 'The study programs of each accreditation.',
    },
    description: 'The undergraduate accreditations and their subjects.',
    name: 'Accreditations',
  },
  {
    collections: {
      degree_program_courses:
        'The courses of each program: mandatory or elective, semester, group and code.',
      degree_program_slots: "The elective slots of each master's program.",
      degree_programs:
        'Study programs of all three cycles: names, duration, accreditation, language, degree title, credits and description.',
    },
    description: 'Study programs and their curricula.',
    name: 'Degree Programs',
  },
  {
    collections: {
      deans_office: "The dean's office of each term.",
      staff:
        'Teaching staff: title, position, office, email and profile links.',
      student_council: 'The faculty student assembly (ФСС) of each year.',
      students: 'Students who are student assembly members, by name.',
    },
    description: 'Staff, faculty management and the student assembly.',
    name: 'People',
  },
  {
    collections: {
      exam_sessions:
        'Exam sessions and colloquium weeks with their schedule files.',
      room_aliases: 'Other spellings of room names used by the timetables.',
      rooms: 'Rooms: type, location, floor and capacity.',
      timetable_lessons:
        'Every subject and teacher of a timetable, with the course and staff member it matches.',
      timetable_slot_courses: 'The courses a timetable class stands for.',
      timetable_slot_staff: 'The staff members of a timetable class.',
      timetable_slots:
        'The classes of the main timetables: day, time, teachers, groups and room.',
      timetables: 'The imported timetables of each semester.',
    },
    description: 'Timetables, rooms and exam sessions.',
    name: 'Timetables & Rooms',
  },
  {
    collections: {
      academic_years: 'Academic years.',
      course_enrollments:
        'Students enrolled in each course per academic year, counted from Moodle.',
    },
    description: 'Enrollment counts per course and year.',
    name: 'Enrollments',
  },
  {
    collections: {
      bachelor_theses: "Bachelor's theses: student, title, status and dates.",
      bachelor_thesis_staff:
        "Mentors and committee members of each bachelor's thesis.",
      master_theses: "Master's theses: student, title, status and dates.",
      master_thesis_staff:
        "Mentors and committee members of each master's thesis.",
    },
    description: "Bachelor's and master's theses.",
    name: 'Theses',
  },
  {
    collections: {
      anto_quotes: 'Anto quotes.',
      discord_channel_courses: 'The courses each Discord channel is for.',
      discord_channels: 'Course channels of the FINKI Hub Discord server.',
    },
    description: 'Data the FINKI Hub Discord bot uses.',
    name: 'Discord Bot',
  },
];

export const legacyTag = 'Legacy Files';

// The /legacy files and what each holds.
export const legacyFileDescriptions: Readonly<Record<string, string>> = {
  'anto.json': 'Anto quotes, as an array of strings.',
  'bachelor_theses.json': "Bachelor's theses with their committees.",
  'courses.json':
    'Every course with its accreditations, staff and enrollment counts, in the format the FINKI Hub site and bot read.',
  'degree_program_courses.json': 'The courses of every study program.',
  'degree_programs.json': 'Every study program.',
  'master_theses.json': "Master's theses with their committees.",
  'rooms.json': 'Every room.',
  'sessions.json': 'Exam session names mapped to their schedule files.',
  'staff.json': 'Every staff member.',
};

const description = `Read-only public data of FINKI Hub: courses, accreditations, staff, timetables, rooms, enrollments, theses and more. No authentication is needed and CORS is open.

**REST.** \`GET /items/<collection>\` lists a collection and \`GET /items/<collection>/<id>\` reads one item. The standard Directus query parameters apply: \`fields\` (including related fields, such as \`fields=name,staff.name\`), \`filter\`, \`search\`, \`sort\`, \`limit\`, \`offset\`, \`page\` and \`deep\`, for example \`/items/courses?fields=name,abbreviation&filter[status][_eq]=active&limit=10\`.

**GraphQL.** \`POST /graphql\`, with the schema at [/server/specs/graphql](/server/specs/graphql).

**Files.** The \`/legacy\` JSON files are ready-made exports of the most used data.

This reference describes the anonymous API. The full generated specification is at [/server/specs/oas](/server/specs/oas).`;

type Operation = Record<string, unknown>;
type PathItem = Record<string, Operation>;
type Spec = Record<string, unknown> & { paths?: Record<string, PathItem> };

const itemsPath = /^\/items\/(?<collection>[^/]+)(?<one>\/\{id\})?$/u;

const groupOf = (collection: string) =>
  docsGroups.find((group) => Object.hasOwn(group.collections, collection));

const legacyPaths = (filenames: readonly string[]): Record<string, PathItem> =>
  Object.fromEntries<PathItem>([
    ...filenames.map((filename): [string, PathItem] => [
      `/legacy/${filename}`,
      {
        get: {
          description: legacyFileDescriptions[filename] ?? '',
          operationId: `legacy_${filename.replace('.json', '')}`,
          responses: {
            '200': {
              content: { 'application/json': { schema: {} } },
              description: 'The file, built from the live data.',
            },
          },
          summary: filename,
          tags: [legacyTag],
        },
      },
    ]),
    [
      '/legacy/sessions/{file}',
      {
        get: {
          description:
            'The schedule file an exam session of sessions.json links.',
          operationId: 'legacy_session_file',
          parameters: [
            {
              in: 'path',
              name: 'file',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: { '200': { description: 'The schedule file.' } },
          summary: 'Exam session schedule file',
          tags: [legacyTag],
        },
      },
    ],
  ]);

// The anonymous OpenAPI document as the docs show it: only reading the
// public collections, each operation tagged with its group and described,
// and the /legacy files added.
export const curateSpec = (
  raw: Spec,
  publicUrl: string,
  legacyFilenames: readonly string[],
): Spec => {
  const paths: Record<string, PathItem> = {};

  const rawPaths = Object.entries(raw.paths ?? {});

  for (const [path, item] of rawPaths) {
    const match = itemsPath.exec(path);
    const collection = match?.groups?.['collection'];
    const group = collection === undefined ? undefined : groupOf(collection);

    if (
      collection === undefined ||
      group === undefined ||
      item['get'] === undefined
    ) {
      continue;
    }

    const one = match?.groups?.['one'] !== undefined;
    paths[path] = {
      get: {
        ...item['get'],
        description: group.collections[collection],
        summary: one ? `Get one ${collection} item` : `List ${collection}`,
        tags: [group.name],
      },
    };
  }

  return {
    ...raw,
    info: {
      description,
      title: 'FINKI Hub Data API',
      version: '1',
    },
    paths: { ...paths, ...legacyPaths(legacyFilenames) },
    servers: [{ url: publicUrl }],
    tags: [
      ...docsGroups.map(({ description: text, name }) => ({
        description: text,
        name,
      })),
      { description: 'Ready-made JSON exports.', name: legacyTag },
    ],
  };
};

export const scalarVersion = '1.76.4';
export const scalarScript = `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${scalarVersion}/dist/browser/standalone.js`;

// The page loads the reference script from jsdelivr only; Directus's own
// policy allows its own scripts alone, so the page sends its own.
export const docsContentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' https://cdn.jsdelivr.net`,
  "style-src 'self' 'unsafe-inline' https:",
  "font-src 'self' https: data:",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

export const docsPage = (specPath: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>FINKI Hub Data API</title>
  </head>
  <body>
    <script id="api-reference" data-url="${specPath}"></script>
    <script src="${scalarScript}"></script>
  </body>
</html>
`;
