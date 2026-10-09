import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { exportDefinitions } from '../../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { readinessRegistry } from '../../directus/extensions/directus-extension-data-operations/src/exports/readiness-registry.js';
import {
  installDataModel,
  SchemaRefusalError,
} from '../../src/data-model/install.js';
import { flowFamilies } from '../../src/flows/registry.js';
import { countByCode } from '../../src/import/findings.js';
import { planImport } from '../../src/import/plan.js';
import { writePlan } from '../../src/import/write.js';
import { runSetup } from '../../src/setup.js';
import { loadWorkbook } from '../../src/workbook.js';
import { academicYears } from '../fixtures/synthetic-data.js';
import { syntheticWorkbook } from '../fixtures/synthetic-workbook.js';
import { assertMarkerPresent, targetFrom } from '../isolated-target.mjs';
import { flowTemplates } from '../registry-test-helpers.js';
import { parityDataset } from '../relational-export-helpers.js';
import { settle } from './automatic-processing-helpers.mjs';
import {
  adminRequest,
  pauseAutomaticProcessing,
  recording,
  userCollections,
  withDataModel,
} from './data-model-helpers.mjs';
import {
  declaredChoices,
  declaredEnum,
  driftEnum,
  liveMeta,
  refusedCreate,
  withoutKey,
} from './declared-vocabularies-helpers.mjs';
import {
  engineFiles,
  prepare,
  readiness,
  restReader,
} from './export-projection-helpers.mjs';
import { count, get, patch, post, remove } from './history-index-helpers.mjs';

// The declared vocabularies on a live project: setup installs every Flow
// family through one loop and keeps enum choices in step (refusing a
// stored value outside a closed list, never one of an allow-other list),
// the one-time import seeds the academic years its workbook names, the
// published flag of a year decides its key in courses.json, and a mapping
// in an unpublished year neither blocks nor warns.

const nothingToResume = () => Promise.resolve();
const laterYear = '2026/2027';
const sixteenYears = [laterYear, ...academicYears];
const entries = 'moodle_course_entries';
const coursesCollection = 'courses';
const statusField = 'status';
const oneValuePattern =
  /^Field courses\.status: 1 value outside declared choices: /mu;
const deferredPattern = /"deferred"/u;
const refusalHeaderPattern = /^data model: \d+ incompatible definitions?$/u;
const yearLabelPattern = /^\d{4}\/\d{4}$/u;

const names = (templates) => templates.map(({ name }) => name);

// The academic-year keys of a course row, in output order.
const yearKeysOf = (row) =>
  Object.keys(row).filter((key) => yearLabelPattern.test(key));

// Setup reports every fixture Flow skipped, per family, and the fixture
// carries every template under its unchanged Flow and operation ids.
const installsFamilies = async ({ directus, state, t, target }) => {
  const summary = await runSetup(directus);
  const templates = flowTemplates();
  assert.deepEqual(
    summary.flows.families.map(({ code, name }) => ({ code, name })),
    flowFamilies.map(({ code, name }) => ({ code, name })),
  );
  assert.deepEqual(summary.flows.created, []);
  assert.deepEqual(summary.flows.skipped, names(templates));
  assert.deepEqual(
    summary.flows.families.map(({ skipped }) => skipped),
    flowFamilies.map(({ templates: family }) => names(family)),
  );
  const listed = await get(target, '/flows?fields=id,operation&limit=-1');
  const flows = new Map(listed.map((flow) => [flow.id, flow.operation]));
  const operations = await get(
    target,
    '/operations?fields=id,flow&limit=-1&sort=id',
  );
  for (const template of templates) {
    assert.equal(flows.get(template.id), template.entry, template.name);
    assert.deepEqual(
      operations.filter(({ flow }) => flow === template.id).map(({ id }) => id),
      template.operations.map(({ id }) => id).toSorted(),
      template.name,
    );
  }
  state.summary = summary;
  t.diagnostic(
    `families ${JSON.stringify(summary.flows.families.map(({ code, skipped }) => [code, skipped.length]))}`,
  );
  await settle(target);
};

// A second setup realigns nothing, and the model install writes nothing.
const rerunsAligned = async ({ directus }) => {
  const again = await runSetup(directus);
  assert.equal(again.fields.aligned, 0);
  assert.equal(again.fields.created, 0);
  assert.deepEqual(again.flows.created, []);
  const recorder = recording(directus);
  const model = await installDataModel(recorder.request);
  assert.deepEqual(recorder.mutations(), []);
  assert.equal(model.fields.aligned, 0);
};

// The course status as an earlier version might have left it (without
// `all_professors`): setup adds the value back and keeps the Studio note
// and width.
const realignsEnum = async ({ directus, target }) => {
  await driftEnum(target, {
    collection: coursesCollection,
    field: statusField,
    values: ['active', 'inactive'],
  });
  const allProfessors = {
    name: 'Synthetic All Professors Course',
    status: 'all_professors',
  };
  assert.equal(
    await refusedCreate(target, coursesCollection, allProfessors),
    'FAILED_VALIDATION',
  );
  const recorder = recording(directus);
  const summary = await installDataModel(recorder.request);
  assert.equal(summary.fields.aligned, 1);
  assert.deepEqual(recorder.mutations(), [
    {
      method: 'PATCH',
      pathname: `/fields/${coursesCollection}/${statusField}`,
    },
  ]);
  assert.ok(
    recorder.calls.some(
      ({ pathname }) =>
        pathname ===
        `/items/${coursesCollection}?aggregate[count]=*&groupBy[]=${statusField}&limit=-1`,
    ),
  );
  const meta = await liveMeta(target, coursesCollection, statusField);
  const declared = declaredChoices(coursesCollection, statusField);
  assert.equal(meta.note, 'Synthetic Studio note');
  assert.equal(meta.width, 'full');
  assert.deepEqual(meta.options.choices, declared.options.choices);
  assert.deepEqual(
    meta.display_options.choices,
    declared.display_options.choices,
  );
  assert.deepEqual(meta.validation, declared.validation);
  const created = await post(
    target,
    `/items/${coursesCollection}`,
    allProfessors,
  );
  assert.equal(created.data.status, 'all_professors');
  await remove(target, `/items/${coursesCollection}/${created.data.id}`);
};

// A stored value the declaration no longer accepts stops setup before any
// write; clearing it lets the next run realign.
const refusesOutOfSet = async ({ directus, target }) => {
  const earlier = ['active', 'all_professors', 'inactive', 'deferred'];
  await driftEnum(target, {
    collection: coursesCollection,
    field: statusField,
    values: earlier,
  });
  const deferred = await post(target, `/items/${coursesCollection}`, {
    name: 'Synthetic Deferred Course',
    status: 'deferred',
  });
  const recorder = recording(directus);
  await assert.rejects(runSetup(recorder.request), (error) => {
    assert.ok(error instanceof SchemaRefusalError);
    const reasons = error.refusals.map(({ reason }) => reason).join('\n');
    assert.match(error.message, refusalHeaderPattern);
    assert.match(reasons, oneValuePattern);
    assert.match(reasons, deferredPattern);
    assert.equal(error.summary.fields.refused, 1);
    return true;
  });
  assert.deepEqual(recorder.mutations(), []);
  const kept = await liveMeta(target, coursesCollection, statusField);
  assert.deepEqual(kept.validation, { status: { _in: earlier } });
  await remove(target, `/items/${coursesCollection}/${deferred.data.id}`);
  const summary = await installDataModel(directus);
  assert.equal(summary.fields.aligned, 1);
  assert.equal(
    await refusedCreate(target, coursesCollection, {
      name: 'Synthetic Deferred Course',
      status: 'deferred',
    }),
    'FAILED_VALIDATION',
  );
  assert.equal(declaredEnum(coursesCollection, statusField).choices.length, 3);
};

// A synthetic staff member holding the position.
const staffWith = (position) => ({
  active: true,
  email: 'synthetic.position@staff.example',
  name: 'Synthetic Position Staff',
  position,
  title: 'Synthetic title',
});

// staff.position as a closed dropdown of an earlier vocabulary, holding a
// value outside it: setup realigns it without reading its values, clears
// the rule and keeps the Studio note and width, and an unlisted value is
// stored as typed again.
const realignsAllowOther = async ({ directus, target }) => {
  const kept = await post(target, '/items/staff', staffWith('Synthetic One'));
  await driftEnum(target, {
    collection: 'staff',
    field: 'position',
    values: ['Доцент'],
  });
  assert.equal(
    await refusedCreate(target, 'staff', staffWith('Synthetic Two')),
    'FAILED_VALIDATION',
  );
  const recorder = recording(directus);
  const summary = await installDataModel(recorder.request);
  assert.equal(summary.fields.aligned, 1);
  assert.equal(summary.fields.refused, 0);
  assert.deepEqual(recorder.mutations(), [
    { method: 'PATCH', pathname: '/fields/staff/position' },
  ]);
  assert.ok(
    recorder.calls.every(({ pathname }) => !pathname.startsWith('/items/')),
  );
  const meta = await liveMeta(target, 'staff', 'position');
  const declared = declaredChoices('staff', 'position');
  assert.equal(meta.note, 'Synthetic Studio note');
  assert.equal(meta.width, 'full');
  assert.deepEqual(meta.options.choices, declared.options.choices);
  assert.equal(meta.options.allowOther, true);
  assert.deepEqual(meta.display_options, declared.display_options);
  assert.equal(meta.validation, null);
  const created = await post(
    target,
    '/items/staff',
    staffWith('Synthetic Two'),
  );
  assert.equal(created.data.position, 'Synthetic Two');
  const stored = await get(
    target,
    `/items/staff/${kept.data.id}?fields=position`,
  );
  assert.equal(stored.position, 'Synthetic One');
  for (const id of [kept.data.id, created.data.id]) {
    await remove(target, `/items/staff/${id}`);
  }
};

// A generated workbook whose listener sheet heads a 16th, later year.
const importsSixteenYears = async ({ directus, state, t, target }) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'declared-vocabularies-'),
  );
  state.directories.push(directory);
  const dataset = parityDataset();
  const withLater = {
    ...dataset,
    course_enrollment_patterns: [
      ...dataset.course_enrollment_patterns,
      {
        academic_year: laterYear,
        course_name: dataset.courses[0].name,
        id: 90,
        pattern: 'Synthetic Later Line',
      },
    ],
  };
  const file = path.join(directory, 'sixteen-years.xlsx');
  await syntheticWorkbook(withLater, sixteenYears).xlsx.writeFile(file);
  const content = await loadWorkbook(file);
  assert.deepEqual(content.academicYears, sixteenYears);
  const plan = planImport(content);
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.unstorable, []);
  assert.equal(countByCode(plan.skipped).unknown_academic_year, undefined);
  const written = await writePlan(directus, plan.collections, {
    batchSize: 250,
    confirmed: (rows) => {
      assert.ok(rows > 0);
    },
  });
  const courses = await count(target, 'courses');
  assert.equal(written.academic_years, 16);
  // The later year's typed cell matches what the course's standard mapping
  // counts there, no line, so it is skipped and no mapping is only in it.
  const cell =
    content.data.course_enrollment_patterns.findIndex(
      (row) => row.academic_year === laterYear,
    ) + 1;
  assert.ok(
    plan.skipped.some(
      ({ code, ids }) => code === 'redundant_pattern' && ids.includes(cell),
    ),
  );
  assert.deepEqual(
    await get(
      target,
      '/items/academic_years?fields=label,published&sort=-label&limit=-1',
    ),
    sixteenYears.map((label) => ({ label, published: true })),
  );
  assert.deepEqual(
    await get(
      target,
      `/items/moodle_pattern_mappings?fields=id&filter[only_in_year][label][_eq]=${encodeURIComponent(laterYear)}&limit=-1`,
    ),
    [],
  );
  const settled = await settle(target, { limitMs: 180_000 });
  // Every course is counted in the later year, with no row added for it.
  const later = await get(
    target,
    `/items/course_enrollments?fields=course&filter[academic_year][label][_eq]=${encodeURIComponent(laterYear)}&limit=-1`,
  );
  assert.equal(later.length, courses);
  t.diagnostic(
    `imported ${JSON.stringify(written)}; settled after ${settled.elapsedMs} ms`,
  );
};

// The prepared courses.json: the operation's digests, and the rows the
// same engine answers in this process over the same rows.
const preparedCourses = async (target) => {
  const run = await prepare(target);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const local = await engineFiles(exportDefinitions, restReader(target));
  assert.deepEqual(
    local.map(({ filename, sha256 }) => [filename, sha256]),
    run.body.files.map(({ filename, sha256 }) => [filename, sha256]),
  );
  const file = local.find(({ filename }) => filename === 'courses.json');
  return { rows: JSON.parse(file.body), sha256: file.sha256 };
};

const setYear = async (target, label, values) => {
  const [year] = await get(
    target,
    `/items/academic_years?fields=id&filter[label][_eq]=${encodeURIComponent(label)}`,
  );
  await patch(target, `/items/academic_years/${year.id}`, values);
  await settle(target, { limitMs: 180_000 });
};

const setPublished = (target, label, published) =>
  setYear(target, label, { published });

// Unpublishing the later year removes exactly its key from every course;
// publishing it again adds exactly that key back.
const followsPublished = async ({ t, target }) => {
  const sixteen = await preparedCourses(target);
  assert.ok(sixteen.rows.length > 0);
  for (const row of sixteen.rows) {
    assert.deepEqual(yearKeysOf(row), sixteenYears);
  }
  await setPublished(target, laterYear, false);
  const fifteen = await preparedCourses(target);
  assert.deepEqual(fifteen.rows, withoutKey(sixteen.rows, laterYear));
  for (const row of fifteen.rows) {
    assert.deepEqual(yearKeysOf(row), [...academicYears]);
  }
  await setPublished(target, laterYear, true);
  const again = await preparedCourses(target);
  assert.equal(again.sha256, sixteen.sha256);
  t.diagnostic(
    `courses.json sha256 16 years ${sixteen.sha256}, 15 years ${fifteen.sha256}`,
  );
};

// An explicit mapping in an unpublished year is counted there and warns
// about nothing; the files still prepare without the year.
const keepsUnpublishedMapping = async ({ state, target }) => {
  const year = await post(target, '/items/academic_years', {
    label: '2027/2028',
  });
  assert.equal(year.data.published, false);
  const entry = await post(target, `/items/${entries}`, {
    label: 'Synthetic unpublished line',
  });
  const [course] = await get(
    target,
    '/items/courses?fields=id&sort=id&limit=1',
  );
  const mapping = await post(target, '/items/moodle_course_mappings', {
    academic_year: year.data.id,
    course: course.id,
    entry: entry.data.id,
  });
  await settle(target, { limitMs: 180_000 });
  const answer = await readiness(target);
  assert.equal(answer.ready, true, JSON.stringify(answer));
  assert.deepEqual(answer.blockers, []);
  assert.deepEqual(
    Object.keys(answer.issueCounts),
    readinessRegistry.map(({ code }) => code),
  );
  const run = await prepare(target);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.deepEqual(run.body.warnings, answer.warnings);
  const { rows } = await preparedCourses(target);
  assert.ok(rows.every((row) => !Object.hasOwn(row, '2027/2028')));
  state.warnings = answer.warnings;
  await remove(target, `/items/moodle_course_mappings/${mapping.data.id}`);
  await remove(target, `/items/${entries}/${entry.data.id}`);
  await remove(target, `/items/academic_years/${year.data.id}`);
};

test('declares vocabularies, years, readiness checks and Flow families once', async (t) => {
  const target = targetFrom(process.env);
  const directus = adminRequest(target);
  const state = { directories: [], summary: null, warnings: null };
  const context = { directus, state, t, target };
  let resume = nothingToResume;
  await withDataModel(
    target,
    async () => {
      try {
        await t.test(
          'installs every Flow family through one loop and skips the fixture Flows',
          () => installsFamilies(context),
        );
        await t.test('reruns setup without realigning anything', () =>
          rerunsAligned(context),
        );
        await t.test(
          'realigns a drifted enum and keeps its Studio note and width',
          () => realignsEnum(context),
        );
        await t.test(
          'refuses to realign a field holding a value outside its choices',
          () => refusesOutOfSet(context),
        );
        await t.test(
          'realigns an allow-other enum holding an unlisted value and clears its rule',
          () => realignsAllowOther(context),
        );
        await t.test(
          'imports a workbook with a 16th academic year and counts every course in it',
          () => importsSixteenYears(context),
        );
        await t.test(
          'publishes exactly one more key per course for a published year',
          () => followsPublished(context),
        );
        await t.test(
          'neither blocks nor warns on a mapping of an unpublished year and prepares the files',
          () => keepsUnpublishedMapping(context),
        );
      } finally {
        await t.test('removes its temporary directories', async () => {
          try {
            for (const directory of state.directories) {
              await rm(directory, { force: true, recursive: true });
            }
          } finally {
            resume = await pauseAutomaticProcessing(target);
          }
        });
      }
    },
    { automatic: true },
  );
  await resume();
  await assertMarkerPresent(target);
  assert.deepEqual(await userCollections(target), [target.markerCollection]);
});
