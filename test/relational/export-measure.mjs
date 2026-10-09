import { performance } from 'node:perf_hooks';

import {
  readFileSources,
  serializeFile,
} from '../../directus/extensions/directus-extension-data-operations/src/exports/engine.js';
import {
  fileShape,
  validateFile,
} from '../../directus/extensions/directus-extension-data-operations/src/exports/file-check.js';
import { get, post } from './history-index-helpers.mjs';

// The realistic dataset of the export measurement (about 1,000 courses
// with two curriculum links, four assignment rows and fifteen legacy rules
// each, 500 staff, 300 rooms, 15,000 students and 200 Moodle users whose
// histories the schedule counts) and the in-process measurement of the
// engine over it. Everything is invented; no address outside .example.

const batch = 1_000;
const pad = (value) => String(value).padStart(4, '0');

const measuredCourse = (index) => `Synthetic Measured Course ${pad(index)}`;

// POSTs rows in batches and answers the created ids in order.
const createAll = async (target, collection, rows) => {
  const ids = [];
  for (let start = 0; start < rows.length; start += batch) {
    const created = await post(
      target,
      `/items/${collection}`,
      rows.slice(start, start + batch),
    );
    ids.push(...created.data.map(({ id }) => id));
  }
  return ids;
};

// A code in FINKI's form F<yy>L<level>W<nnnn>, whose level the
// projection publishes.
const codeOf = (generation, index) =>
  `F${generation.code.slice(-2)}L${String(1 + (index % 3))}W${pad(index)}`;

const entryOf = (generation, index) => ({
  channel: index % 4 !== 0,
  code: codeOf(generation, index),
  generation: generation.id,
  name: `${measuredCourse(index)} (${generation.code})`,
  prerequisites: index % 5 === 0 ? null : codeOf(generation, index - 1),
  semester: 1 + (index % 8),
});

// Two of every three programs of the entry's generation carry a state.
const statesOf = (entries, programs) =>
  entries.flatMap(({ entry, index }) =>
    programs.flatMap((program, position) =>
      (index + position) % 3 === 0
        ? []
        : [
            {
              entry,
              program,
              state: ['mandatory', 'elective'][(index + position) % 2],
            },
          ],
    ),
  );

const courseRows = (count) =>
  Array.from({ length: count }, (_, index) => ({
    name: measuredCourse(index),
    pattern_mappings: [],
    tags: index % 3 === 0 ? null : `synthetic;measured;${index % 7}`,
  }));

const staffRows = (count) =>
  Array.from({ length: count }, (_, index) => ({
    active: index % 9 !== 0,
    cabinet: `B-${pad(index)}`,
    consultations: 'Mondays 10:00-12:00, Thursdays 14:00-15:30 (synthetic)',
    courses: `${measuredCourse(index)}, ${measuredCourse(index + 1)}`,
    email: `staff${index}@staff.example`,
    name: `Prof. Synthetic Staff ${pad(index)}`,
    position: 'Professor',
    profile: `https://staff.example/profiles/${index}`,
    title: 'Prof.',
  }));

const roomRows = (count) =>
  Array.from({ length: count }, (_, index) => ({
    capacity: index % 11 === 0 ? 0 : 20 + (index % 180),
    description: index % 4 === 0 ? null : `Synthetic room ${pad(index)}`,
    floor: (index % 6) - 1,
    location: `Synthetic Building ${index % 9}`,
    mrbs: `https://mrbs.example/rooms/${index}`,
    name: `Synthetic Measured Room ${pad(index)}`,
    type: index % 2 === 0 ? 'lab' : 'hall',
  }));

const studentRows = (count) =>
  Array.from({ length: count }, (_, index) => ({
    index_number: `SYN-M${String(index).padStart(5, '0')}`,
    name: `Synthetic Measured Student ${String(index).padStart(5, '0')}`,
    source_group: 'synthetic-measured-list',
  }));

// A history of five measured course lines per user.
const userRows = (count, courses, years) =>
  Array.from({ length: count }, (_, index) => {
    const lines = [0, 1, 2, 3, 4].map(
      (line) =>
        `${measuredCourse((index * 7 + line * 131) % courses)}-${years[(index + line) % years.length]}`,
    );
    return {
      Courses: lines.join('\n'),
      'Courses Count': lines.length,
      Name: `Synthetic Measured User ${pad(index)}`,
    };
  });

const assignmentsOf = (courseIds, staffIds) =>
  courseIds.flatMap((course, index) => {
    const staffAt = (offset) => staffIds[(index + offset) % staffIds.length];
    const base = { course };
    return [
      { ...base, role: 'professor', sort: 1, staff: staffAt(0) },
      { ...base, role: 'professor', sort: 2, staff: staffAt(7) },
      { ...base, role: 'assistant', sort: 1, staff: staffAt(13) },
      { ...base, role: 'assistant', sort: 2, staff: staffAt(19) },
    ];
  });

// Seeds the realistic dataset beside whatever the project holds, with
// legacy rules the schedule counts over the synthetic histories; answers
// the row counts and how long the seeding took.
export const seedRealistic = async (target, scale = 1) => {
  const started = performance.now();
  const count = { courses: 1_000 * scale, rooms: 300 * scale };
  const years = await get(
    target,
    '/items/academic_years?fields=id,label&sort=id&limit=-1',
  );
  // The generations and programs the import seeded.
  const generations = await get(
    target,
    '/items/curriculum_generations?fields=id,code&limit=-1',
  );
  const programs = await get(
    target,
    '/items/study_programs?fields=id,generation&sort=sort&limit=-1',
  );
  const generationOf = (code) => generations.find((row) => row.code === code);
  const programsOf = (generation) =>
    programs
      .filter((row) => row.generation === generation.id)
      .map(({ id }) => id);
  const [currentGeneration, legacyGeneration] = [
    generationOf('2023'),
    generationOf('2018'),
  ];
  const courseIds = await createAll(
    target,
    'courses',
    courseRows(count.courses),
  );
  const current = await createAll(
    target,
    'curriculum_entries',
    courseIds.map((_, index) => entryOf(currentGeneration, index)),
  );
  const legacyIndexes = courseIds.flatMap((_, index) =>
    index % 10 < 7 ? [index] : [],
  );
  const legacy = await createAll(
    target,
    'curriculum_entries',
    legacyIndexes.map((index) => entryOf(legacyGeneration, index)),
  );
  const states = [
    ...statesOf(
      current.map((entry, index) => ({ entry, index })),
      programsOf(currentGeneration),
    ),
    ...statesOf(
      legacy.map((entry, position) => ({
        entry,
        index: legacyIndexes[position],
      })),
      programsOf(legacyGeneration),
    ),
  ];
  await createAll(target, 'curriculum_entry_program_states', states);
  const links = [
    ...courseIds.map((course, index) => ({
      available: index % 2 === 0,
      course,
      credits: 6,
      entry: current[index],
      generation: currentGeneration.id,
      sort: 1,
    })),
    ...legacyIndexes.map((index, position) => ({
      available: index % 3 === 0,
      course: courseIds[index],
      credits: index % 9 === 0 ? 0 : 6,
      entry: legacy[position],
      generation: legacyGeneration.id,
      sort: 2,
    })),
  ];
  await createAll(target, 'course_curricula', links);
  const staffIds = await createAll(target, 'staff', staffRows(500 * scale));
  const assignments = assignmentsOf(courseIds, staffIds);
  await createAll(target, 'teaching_assignments', assignments);
  await createAll(target, 'rooms', roomRows(count.rooms));
  await createAll(target, 'students', studentRows(15_000 * scale));
  const rules = courseIds.flatMap((course, index) =>
    years.map((year) => ({
      academic_year: year.id,
      course,
      mode: 'legacy_regex',
      pattern: `${measuredCourse(index)}-${year.label}`,
    })),
  );
  await createAll(target, 'course_enrollment_rules', rules);
  const labels = years.map(({ label }) => label);
  await createAll(target, 'moodle_users', userRows(200, count.courses, labels));
  return {
    rows: {
      assignments: assignments.length,
      courses: courseIds.length,
      links: links.length,
      rooms: count.rooms,
      rules: rules.length,
      staff: staffIds.length,
      states: states.length,
      students: 15_000 * scale,
      users: 200,
    },
    seedMs: Math.round(performance.now() - started),
  };
};

const megabytes = (bytes) => Math.round((bytes / 1_024 / 1_024) * 10) / 10;

const collect = () => {
  if (typeof globalThis.gc === 'function') globalThis.gc();
};

// The engine in this process over the live rows: reads through the
// reader, then serialization and validation of every file while all
// sources are held, with the heap growth of each stage (after a forced
// collection when node runs with --expose-gc).
export const measureEngine = async (definitions, reader) => {
  collect();
  const base = process.memoryUsage().heapUsed;
  const readStarted = performance.now();
  const sources = [];
  for (const definition of definitions) {
    sources.push(await readFileSources(definition, reader));
  }
  const readMs = performance.now() - readStarted;
  collect();
  const afterRead = process.memoryUsage().heapUsed;
  const built = performance.now();
  const files = definitions.map((definition, index) =>
    validateFile(
      definition,
      serializeFile(definition, sources[index]),
      fileShape(definition, sources[index]),
    ),
  );
  const buildMs = performance.now() - built;
  const peak = process.memoryUsage().heapUsed;
  collect();
  const afterBuild = process.memoryUsage().heapUsed;
  return {
    bytes: Object.fromEntries(files.map((file) => [file.filename, file.bytes])),
    gcForced: typeof globalThis.gc === 'function',
    heapMb: {
      filesRetained: megabytes(afterBuild - afterRead),
      peakAboveBase: megabytes(peak - base),
      sourcesRetained: megabytes(afterRead - base),
    },
    readMsOverRest: Math.round(readMs),
    rows: Object.fromEntries(files.map((file) => [file.filename, file.rows])),
    serializeAndValidateMs: Math.round(buildMs),
    sha256: Object.fromEntries(
      files.map((file) => [file.filename, file.sha256]),
    ),
  };
};
