import assert from 'node:assert/strict';

import {
  defaultPattern,
  defaultYearPattern,
} from '../directus/extensions/directus-extension-data-operations/src/enrollment-lines.js';
import { assignmentRoles } from '../directus/extensions/directus-extension-data-operations/src/exports/teaching-values.js';
import {
  curriculumPlan,
  generationSeeds,
  modelRows,
  referenceCollections,
  yearRows,
} from './fixtures/stress-fixture.js';
import { expectedCounts } from './fixtures/stress-oracle.js';
import {
  courseName,
  historiesOf,
  stressLabels,
  stressLines,
  stressRows,
} from './fixtures/stress-snapshot.js';
import { json, read, request } from './relational/data-model-helpers.mjs';
import { get } from './relational/history-index-helpers.mjs';

// Writes the generated fixture of test/fixtures/stress-*.ts through the
// public REST API of the isolated target, in batches, and answers the ids
// the scenarios and the oracle need. Everything it writes is synthetic
// and lives in model collections, which the model teardown removes.

const batchSize = 500;

// Creates rows in batches; answers the created ids in row order.
export const createRows = async (target, collection, rows) => {
  const ids = [];
  for (let start = 0; start < rows.length; start += batchSize) {
    const answer = await read(
      await request(
        target,
        `/items/${collection}`,
        json('POST', rows.slice(start, start + batchSize), target.token),
      ),
      200,
    );
    ids.push(...answer.data.map(({ id }) => id));
  }
  assert.equal(ids.length, rows.length, `${collection}: every row created`);
  return ids;
};

// The years of the model plus the unpublished newer one.
const seedYears = async (target, declarations) => {
  const rows = yearRows(declarations.years);
  const ids = await createRows(target, 'academic_years', rows);
  return rows.map((row, index) => ({ ...row, id: ids[index] }));
};

// The declared generations and programs, created as rows and read back:
// everything below them follows the created rows.
const seedGenerations = async (target, declarations) => {
  const seeds = generationSeeds(declarations);
  const generationIds = await createRows(
    target,
    'curriculum_generations',
    seeds.generations,
  );
  const generations = seeds.generations.map((row, index) => ({
    ...row,
    id: generationIds[index],
  }));
  const byCode = new Map(generations.map((row) => [row.code, row.id]));
  const programRows = seeds.programs.map((program) => ({
    ...program,
    generation: byCode.get(program.generation),
  }));
  const programIds = await createRows(target, 'study_programs', programRows);
  return {
    generations,
    programs: programRows.map((row, index) => ({
      ...row,
      id: programIds[index],
    })),
  };
};

// The curriculum entries, their program states and the course links the
// plan derives from the created generation, program and course rows.
export const seedCurriculum = async (target, rows) => {
  const plan = curriculumPlan(rows.generations, rows.programs, rows.courses);
  const entries = await createRows(
    target,
    'curriculum_entries',
    plan.map(({ entry }) => entry),
  );
  const states = plan.flatMap(({ states: owned }, index) =>
    owned.map((state) => ({ ...state, entry: entries[index] })),
  );
  await createRows(target, 'curriculum_entry_program_states', states);
  const links = plan.map(({ link }, index) => ({
    ...link,
    entry: entries[index],
  }));
  const linkIds = await createRows(target, 'course_curricula', links);
  return { entries, links: linkIds, states: states.length };
};

// The rows of every other collection an export reads, from its model
// fields; answers the ids per collection.
const seedReferenceRows = async (target, declarations, count) => {
  const created = {};
  for (const collection of referenceCollections(declarations.definitions)) {
    created[collection] = await createRows(
      target,
      collection,
      modelRows(collection, count),
    );
  }
  return created;
};

// A professor for every course, so no Active course blocks publishing
// (course_without_professor), and an assistant for every other course,
// from the created staff (none without staff rows).
const seedAssignments = (target, courses, staff) => {
  if (staff.length === 0) return Promise.resolve([]);
  const [professor, assistant] = assignmentRoles;
  const rows = courses.flatMap((course, index) => [
    {
      course: course.id,
      role: professor,
      sort: 1,
      staff: staff[index % staff.length],
    },
    ...(index % 2 === 0
      ? [
          {
            course: course.id,
            role: assistant,
            sort: 2,
            staff: staff[(index + 1) % staff.length],
          },
        ]
      : []),
  ]);
  return createRows(target, 'teaching_assignments', rows);
};

// The first staff member, by id, a teaching link can move to: one not yet
// linked to its course in its role, since the database refuses a second
// (course, staff, role) link.
export const staffFreeFor = async (target, { course, role }) => {
  const taken = await get(
    target,
    `/items/teaching_assignments?fields=staff&filter[course][_eq]=${course}&filter[role][_eq]=${role}&limit=-1`,
  );
  const staff = await get(
    target,
    '/items/staff?fields=id,name&sort=id&limit=-1',
  );
  const free = staff.find(({ id }) => taken.every((row) => row.staff !== id));
  assert.ok(free, `no staff member is free for course ${course} as ${role}`);
  return free;
};

// The default pattern mapping of every course, `<escaped name>-` with the
// default year pattern, as the one-time import writes it; answers them in
// oracle form (the course as its position).
const seedPatternMappings = async (target, courses) => {
  const rows = courses.map((course) => ({
    course: course.id,
    pattern: defaultPattern(course.name),
    year_pattern: defaultYearPattern,
  }));
  const ids = await createRows(target, 'moodle_pattern_mappings', rows);
  return courses.map((course, index) => ({
    course: course.index,
    id: ids[index],
    onlyInYear: null,
    pattern: rows[index].pattern,
    yearPattern: defaultYearPattern,
  }));
};

// The whole reference side: years, generations and programs, courses,
// curriculum, the other exported collections, assignments and the default
// pattern mapping of every course.
export const seedReference = async (
  target,
  declarations,
  { courses: courseCount, referenceRows },
) => {
  const years = await seedYears(target, declarations);
  const { generations, programs } = await seedGenerations(target, declarations);
  // An explicitly empty list: no default pattern mapping is created.
  const courseRows = Array.from({ length: courseCount }, (_, index) => ({
    name: courseName(index),
    pattern_mappings: [],
    tags: index % 4 === 0 ? null : `synthetic, tag ${index % 7}`,
  }));
  const courseIds = await createRows(target, 'courses', courseRows);
  const courses = courseRows.map(({ name }, index) => ({
    id: courseIds[index],
    index,
    name,
  }));
  const curriculum = await seedCurriculum(target, {
    courses,
    generations,
    programs,
  });
  const reference = await seedReferenceRows(
    target,
    declarations,
    referenceRows,
  );
  const assignments = await seedAssignments(
    target,
    courses,
    reference.staff ?? [],
  );
  const patterns = await seedPatternMappings(target, courses);
  return {
    assignments,
    courses,
    curriculum,
    generations,
    patterns,
    programs,
    reference,
    years,
  };
};

// The generated snapshot for the created courses and years: the rows in
// declaration order, their raw histories, the lines the generator chose
// for each history (the oracle's entries) and the labels.
export const snapshotFor = (
  declarations,
  seeded,
  { labels: labelCount, offset = 0, users },
) => {
  const labels = stressLabels(
    seeded.courses.map(({ name }) => name),
    seeded.years.map(({ label }) => label),
    labelCount,
  );
  const rows = stressRows(users, {
    declaration: declarations.snapshot,
    labels,
    offset,
  });
  return {
    histories: historiesOf(declarations.snapshot, rows),
    labels,
    lines: stressLines(users, labels),
    rows,
  };
};

// The id of every history entry, by exact label.
export const entryIds = async (target) => {
  const rows = await get(
    target,
    '/items/moodle_course_entries?fields=id,label&limit=-1',
  );
  return new Map(rows.map(({ id, label }) => [label, id]));
};

// One mapping per label of the given year (the entry to its course and
// that year), in oracle form; the entries must be indexed.
export const seedMappings = async (target, { labels, seeded, year }) => {
  const entries = await entryIds(target);
  const mappings = [...labels.pairs]
    .filter(([, pair]) => pair.year === year)
    .map(([label, pair]) => ({ ...pair, label }));
  await createRows(
    target,
    'moodle_course_mappings',
    mappings.map(({ course, label, year: position }) => ({
      academic_year: seeded.years[position].id,
      course: seeded.courses[course].id,
      entry: entries.get(label),
    })),
  );
  return mappings;
};

// The installed counts in oracle form (`<course position>/<year
// position>`), for the rows of the created courses and years.
export const installedCounts = async (target, seeded) => {
  const courses = new Map(seeded.courses.map(({ id, index }) => [id, index]));
  const years = new Map(seeded.years.map(({ id }, index) => [id, index]));
  const rows = await get(
    target,
    '/items/course_enrollments?fields=course,academic_year,count&limit=-1',
  );
  return new Map(
    rows
      .filter(
        ({ academic_year, course }) =>
          courses.has(course) && years.has(academic_year),
      )
      .map(({ academic_year, count, course }) => [
        `${courses.get(course)}/${years.get(academic_year)}`,
        count,
      ]),
  );
};

// The pattern mappings of the created courses as the database holds them,
// in oracle form (course and only-in-year year as positions).
export const patternsOf = async (target, seeded) => {
  const courses = new Map(seeded.courses.map(({ id, index }) => [id, index]));
  const years = new Map(seeded.years.map(({ id }, index) => [id, index]));
  const rows = await get(
    target,
    '/items/moodle_pattern_mappings?fields=id,course,pattern,year_pattern,only_in_year&sort=id&limit=-1',
  );
  return rows
    .filter(({ course }) => courses.has(course))
    .map((row) => ({
      course: courses.get(row.course),
      id: row.id,
      onlyInYear:
        row.only_in_year === null ? null : years.get(row.only_in_year),
      pattern: row.pattern,
      yearPattern: row.year_pattern,
    }));
};

// The oracle's counts for the state of a suite: its snapshot's lines, the
// pattern mappings and explicit mappings in oracle form, every created
// course and year (positions, years with their labels).
export const oracleCounts = (state) =>
  expectedCounts(state.snapshotRows, {
    courses: state.seeded.courses.map(({ index }) => index),
    explicit: state.mappings,
    mappings: state.patterns,
    years: state.seeded.years.map(({ label }, index) => ({ id: index, label })),
  });

// How many pairs differ between two count maps (never which values).
export const countDifferences = (expected, installed) => {
  const keys = new Set([...expected.keys(), ...installed.keys()]);
  return [...keys].filter((key) => expected.get(key) !== installed.get(key))
    .length;
};
