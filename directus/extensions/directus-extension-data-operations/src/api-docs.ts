// The public API reference at /docs: the OpenAPI document Directus generates
// for anonymous callers, cut down to what they can use (reading the public
// collections), described and grouped by subject like the Studio sidebar,
// with the /catalog files added. This module imports nothing, so the docs
// endpoint and the tests read it.

export type DocsGroup = {
  readonly collections: Readonly<Record<string, string>>;
  readonly description: string;
  // A query of the group's main collection, checked against live data.
  readonly example: string;
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
    example:
      '/items/courses?fields=name,abbreviation,name_en&filter[abbreviation][_eq]=АПС',
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
    example:
      '/items/course_teaching?fields=role,staff.name,timetable.title&filter[course][name][_eq]=Бази на податоци',
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
    example:
      '/items/curriculum_entries?fields=code,name,semester,prerequisites&filter[generation][code][_eq]=2023&limit=10',
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
    example:
      '/items/degree_programs?fields=code,name,cycle,duration_years&filter[cycle][_eq]=second',
    name: 'Degree Programs',
  },
  {
    collections: {
      deans_office:
        'The dean, vice deans and secretary (Деканат) of each term.',
      faculty_body_members:
        'The current members of the management board (Деканатска управа) and of the teaching and research council (Наставно-научен совет), in page order.',
      faculty_centers: 'The faculty centers and their heads.',
      institute_members: 'The staff members of each institute.',
      institutes: 'The institutes of the faculty and their heads.',
      staff:
        'Staff members, visiting professors and external collaborators: title, position, office, email, profile links, photo, biography, and whether they are active and FINKI staff.',
      student_council:
        'The members of the faculty student council (ФСС) of each year, by position.',
      students:
        'The students who have sat on the student council, by name only. Other students are not public.',
    },
    description:
      'Staff, faculty management, institutes, centers and the student council.',
    example:
      '/items/staff?fields=name,title,position,email,cabinet,photo&search=Димитрова',
    name: 'People',
  },
  {
    collections: {
      exam_sessions:
        'Exam sessions and colloquiums of each academic year, with their schedule files.',
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
    example:
      '/items/rooms?fields=name,type,location,capacity&filter[capacity][_gte]=100',
    name: 'Timetables & Rooms',
  },
  {
    collections: {
      academic_years: 'Academic years.',
      course_enrollments:
        'Students enrolled in each course per academic year, counted from Moodle.',
    },
    description: 'Enrollment counts per course and year.',
    example:
      '/items/course_enrollments?fields=count,course.name,academic_year.label&filter[academic_year][label][_eq]=2025/2026&sort=-count&limit=10',
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
    example:
      '/items/bachelor_theses?fields=title,student_name,year,mentor.name&filter[year][_eq]=2026&limit=10',
    name: 'Theses',
  },
  {
    collections: {
      anto_quotes: 'Anto quotes.',
      discord_channel_courses: 'The courses each Discord channel is for.',
      discord_channels: 'Course channels of the FINKI Hub Discord server.',
    },
    description: 'Data the FINKI Hub Discord bot uses.',
    example:
      '/items/discord_channels?fields=channel,semester,courses.course.name',
    name: 'Discord Bot',
  },
];

export const catalogTag = 'Catalog';

// The /catalog files and what each holds.
export const catalogFileDescriptions: Readonly<Record<string, string>> = {
  'courses.json':
    'Every course with its accreditations, staff and enrollment counts, built from several collections.',
};

export type ApiDocsCollection = {
  readonly fields: Readonly<Record<string, ApiDocsField>>;
  readonly plural: string;
  readonly singular: string;
};

// The model as the reference shows it (api-docs-model.json, generated by
// `npm run generate:api-docs` from src/data-model): the Studio names of
// each public collection and of its public fields.
export type ApiDocsField = {
  readonly label: string;
  readonly note?: string;
  readonly related?: {
    readonly collection: string;
    readonly label?: string;
    readonly many: boolean;
  };
};

export type ApiDocsModel = {
  readonly collections: Readonly<Record<string, ApiDocsCollection>>;
};

// One JSON schema, as OpenAPI 3.0 writes it.
export type JsonSchema = Record<string, unknown>;

const description = `Read-only public data of FINKI Hub: courses, accreditations, staff, timetables, rooms, enrollments, theses and more. No authentication is needed and CORS is open.

**REST.** \`GET /items/<collection>\` lists a collection and \`GET /items/<collection>/<id>\` reads one item. The standard Directus query parameters apply: \`fields\` (including related fields, such as \`fields=name,staff.name\`), \`filter\`, \`search\`, \`sort\`, \`limit\` (100 by default, \`-1\` for all), \`offset\`, \`page\` and \`deep\`, for example \`/items/courses?fields=name,abbreviation&filter[status][_eq]=active&limit=10\`. A relation is returned as the related item's id unless its fields are asked for. Each group below has an example.

**GraphQL.** \`POST /graphql\`, with the schema at [/server/specs/graphql](/server/specs/graphql).

**Catalog.** \`/catalog/courses.json\` is every course as one ready-made file.

**Files.** Exam schedules are public at \`/assets/<file id>/<file name>\`; \`exam_sessions\` links them.

This reference describes the anonymous API. The full generated specification is at [/server/specs/oas](/server/specs/oas).`;

type Operation = Record<string, unknown>;
type PathItem = Record<string, Operation>;
type Spec = Record<string, unknown> & { paths?: Record<string, PathItem> };

const itemsPath = /^\/items\/(?<collection>[^/]+)(?<one>\/\{id\})?$/u;

const groupOf = (collection: string) =>
  docsGroups.find((group) => Object.hasOwn(group.collections, collection));

// The Directus schema name of a collection: ItemsCourseTeaching.
const schemaName = (collection: string) =>
  `Items${collection
    .split('_')
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join('')}`;

const endsSentence = /[.!?]$/u;

// "Mentor (Staff Member). The note." A relation names what it points to;
// a note is the Studio note.
export const fieldDescription = (field: ApiDocsField) => {
  const target = field.related?.label ?? field.related?.collection;
  let text = field.label;
  // A relation named as its target says nothing more by naming it.
  if (target !== undefined && target !== field.label) {
    text +=
      field.related?.many === true ? ` (list of ${target})` : ` (${target})`;
  }
  if (field.note !== undefined) {
    text += `. ${field.note}`;
  }
  return endsSentence.test(text) ? text : `${text}.`;
};

// OpenAPI 3.0 allows `nullable` only beside a `type`: Directus writes it on
// relations (an id or the related item, a `oneOf`) too, where it is dropped.
const fixNullable = (property: JsonSchema): JsonSchema =>
  property['type'] === undefined && 'nullable' in property
    ? Object.fromEntries(
        Object.entries(property).filter(([key]) => key !== 'nullable'),
      )
    : property;

const describeSchemas = (
  schemas: Record<string, JsonSchema>,
  model: ApiDocsModel,
) => {
  const byName = new Map(
    Object.entries(model.collections).map(([collection, entry]) => [
      schemaName(collection),
      entry,
    ]),
  );
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => {
      const entry = byName.get(name);
      const properties = (schema['properties'] ?? {}) as Record<
        string,
        JsonSchema
      >;
      return [
        name,
        {
          ...schema,
          ...(entry !== undefined && { description: entry.plural }),
          properties: Object.fromEntries(
            Object.entries(properties).map(([field, property]) => {
              const known = entry?.fields[field];
              return [
                field,
                fixNullable(
                  known === undefined
                    ? property
                    : { ...property, description: fieldDescription(known) },
                ),
              ];
            }),
          ),
        },
      ];
    }),
  );
};

// The most keys an object may have before it reads as a map: sessions.json
// maps every session's name to its file.
const mapKeys = 25;

const typeOf = (value: unknown) => {
  if (Array.isArray(value)) {
    return 'array';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? 'integer' : 'number';
  }
  return typeof value;
};

const mergeSchemas = (left: JsonSchema, right: JsonSchema): JsonSchema => {
  if (left['type'] !== right['type']) {
    return {};
  }
  if (left['type'] === 'array') {
    return {
      items: mergeSchemas(
        (left['items'] ?? {}) as JsonSchema,
        (right['items'] ?? {}) as JsonSchema,
      ),
      type: 'array',
    };
  }
  if (left['type'] !== 'object' || left['properties'] === undefined) {
    return left;
  }
  const leftProperties = left['properties'] as Record<string, JsonSchema>;
  const rightProperties = (right['properties'] ?? {}) as Record<
    string,
    JsonSchema
  >;
  const properties: Record<string, JsonSchema> = { ...leftProperties };
  for (const [key, schema] of Object.entries(rightProperties)) {
    const known = properties[key];
    properties[key] =
      known === undefined ? schema : mergeSchemas(known, schema);
  }
  const rightRequired = new Set((right['required'] ?? []) as string[]);
  return {
    properties,
    required: ((left['required'] ?? []) as string[]).filter((key) =>
      rightRequired.has(key),
    ),
    type: 'object',
  };
};

// The shape of a /catalog file, read from the file itself: the keys every
// row has are required, a value that is sometimes missing or null is not.
// Only the file itself may be a map; a row is a record
// however many keys it has.
export const inferSchema = (value: unknown, top = true): JsonSchema => {
  const type = typeOf(value);
  if (type === 'array') {
    const items = (value as unknown[]).map((item) => inferSchema(item, false));
    const [first, ...others] = items;
    let merged = first ?? {};
    for (const item of others) {
      merged = mergeSchemas(merged, item);
    }
    return { items: merged, type: 'array' };
  }
  if (type === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, item]) => item !== null,
    );
    const valueTypes = new Set(entries.map(([, item]) => typeOf(item)));
    if (top && entries.length > mapKeys && valueTypes.size === 1) {
      return {
        additionalProperties: inferSchema(entries[0]?.[1], false),
        type: 'object',
      };
    }
    return {
      properties: Object.fromEntries(
        entries.map(([key, item]) => [key, inferSchema(item, false)]),
      ),
      required: entries.map(([key]) => key),
      type: 'object',
    };
  }
  return type === 'null' ? {} : { type };
};

const catalogPaths = (
  filenames: readonly string[],
  schemas: Readonly<Record<string, JsonSchema>>,
): Record<string, PathItem> =>
  Object.fromEntries<PathItem>([
    ...filenames.map((filename): [string, PathItem] => [
      `/catalog/${filename}`,
      {
        get: {
          description: catalogFileDescriptions[filename] ?? '',
          operationId: `catalog_${filename.replace('.json', '')}`,
          responses: {
            '200': {
              content: {
                'application/json': { schema: schemas[filename] ?? {} },
              },
              description: 'The file, built from the live data.',
            },
          },
          summary: filename,
          tags: [catalogTag],
        },
      },
    ]),
  ]);

const tagDescription = (group: DocsGroup) =>
  `${group.description}\n\nExample: [\`${group.example}\`](${group.example})`;

// The anonymous OpenAPI document as the docs show it: only reading the
// public collections, named and described as in Studio and grouped by
// subject, the /catalog files with their shapes, and the schema fixes
// OpenAPI 3.0 validators ask for (a type beside nullable; every operation
// open to anonymous callers).
export const curateSpec = (
  raw: Spec,
  options: {
    readonly catalogFilenames: readonly string[];
    readonly catalogSchemas: Readonly<Record<string, JsonSchema>>;
    readonly model: ApiDocsModel;
    readonly publicUrl: string;
  },
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

    const names = options.model.collections[collection];
    const one = match?.groups?.['one'] !== undefined;
    paths[path] = {
      get: {
        ...item['get'],
        description: group.collections[collection],
        summary: one
          ? `Get one ${names?.singular ?? collection}`
          : `List ${names?.plural ?? collection}`,
        tags: [group.name],
      },
    };
  }

  const components = (raw['components'] ?? {}) as Record<string, unknown>;

  return {
    ...raw,
    components: {
      ...components,
      schemas: describeSchemas(
        (components['schemas'] ?? {}) as Record<string, JsonSchema>,
        options.model,
      ),
    },
    info: {
      description,
      title: 'FINKI Hub Data API',
      version: '1',
    },
    paths: {
      ...paths,
      ...catalogPaths(options.catalogFilenames, options.catalogSchemas),
    },
    security: [{}],
    servers: [{ url: options.publicUrl }],
    tags: [
      ...docsGroups.map((group) => ({
        description: tagDescription(group),
        name: group.name,
      })),
      { description: 'Ready-made JSON exports.', name: catalogTag },
    ],
  };
};

export const scalarVersion = '1.76.4';
export const scalarScript = `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${scalarVersion}/dist/browser/standalone.js`;

// The page loads the reference script from jsdelivr only; Directus's own
// policy allows its own scripts alone, so the page sends its own.
export const docsContentSecurityPolicy = [
  "default-src 'self'",
  // Cloudflare adds its analytics beacon to the pages it serves.
  `script-src 'self' https://cdn.jsdelivr.net https://static.cloudflareinsights.com`,
  "style-src 'self' 'unsafe-inline' https:",
  "font-src 'self' https: data:",
  "img-src 'self' data: https:",
  "connect-src 'self' https://cloudflareinsights.com",
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
