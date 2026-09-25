import assert from 'node:assert/strict';

import { assignmentRoles } from '../directus/extensions/directus-extension-data-operations/src/exports/course-values.js';
import { ruleMode } from '../directus/extensions/directus-extension-data-operations/src/rule-modes.js';
import {
  curriculumPlan,
  generationSeeds,
  referenceCollections,
  specRows,
  yearRows,
} from './fixtures/stress-fixture.js';
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

const legacy = ruleMode('legacy_regex').mode;
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
      specRows(collection, count),
    );
  }
  return created;
};

// A professor for two courses in three and an assistant for every other
// course, from the created staff (none without staff rows); every tenth
// course shows a literal label instead of the staff member's name.
const seedAssignments = (target, courses, staff) => {
  if (staff.length === 0) return Promise.resolve([]);
  const [professor, assistant] = assignmentRoles;
  const rows = courses.flatMap((course, index) => [
    ...(index % 3 === 2
      ? []
      : [
          {
            course: course.id,
            course_name: course.name,
            display_override:
              index % 10 === 0 ? 'Synthetic Guest Lecturer' : null,
            role: professor,
            sort: 1,
            staff: staff[index % staff.length],
          },
        ]),
    ...(index % 2 === 0
      ? [
          {
            course: course.id,
            course_name: course.name,
            role: assistant,
            sort: 2,
            staff: staff[(index + 1) % staff.length],
          },
        ]
      : []),
  ]);
  return createRows(target, 'teaching_assignments', rows);
};

// A legacy rule per course and published year with the default pattern
// `<course name>-<year label>`, as the one-time import seeds them; answers
// them in oracle form (course and year as positions).
const seedLegacyRules = async (target, courses, years) => {
  const rules = courses.flatMap((course, courseIndex) =>
    years.flatMap((year, yearIndex) =>
      year.published
        ? [
            {
              course: courseIndex,
              mode: legacy,
              pattern: `${course.name}-${year.label}`,
              year: yearIndex,
            },
          ]
        : [],
    ),
  );
  await createRows(
    target,
    'course_enrollment_rules',
    rules.map((rule) => ({
      academic_year: years[rule.year].id,
      course: courses[rule.course].id,
      mode: rule.mode,
      pattern: rule.pattern,
      review_note: 'Synthetic legacy rule of the stress fixture.',
    })),
  );
  return rules;
};

// The whole reference side: years, generations and programs, courses,
// curriculum, the other exported collections, assignments and the legacy
// rules of every published year.
export const seedReference = async (
  target,
  declarations,
  { courses: courseCount, referenceRows },
) => {
  const years = await seedYears(target, declarations);
  const { generations, programs } = await seedGenerations(target, declarations);
  const courseRows = Array.from({ length: courseCount }, (_, index) => ({
    name: courseName(index),
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
  const rules = await seedLegacyRules(target, courses, years);
  return {
    assignments,
    courses,
    curriculum,
    generations,
    programs,
    reference,
    rules,
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

// How many pairs differ between two count maps (never which values).
export const countDifferences = (expected, installed) => {
  const keys = new Set([...expected.keys(), ...installed.keys()]);
  return [...keys].filter((key) => expected.get(key) !== installed.get(key))
    .length;
};
