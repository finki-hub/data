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
import { flowFamilies, flowTemplates } from '../../src/flows/registry.js';
import { readInventory } from '../../src/migrations/inventory.js';
import { preflight } from '../../src/migrations/preflight.js';
import {
  convertWorkbook,
  previewBlockers,
} from '../../src/migrations/workbook-adapter.js';
import { runSetup } from '../../src/setup.js';
import { academicYears } from '../../src/specs/public.js';
import { loadWorkbook } from '../../src/workbook.js';
import { syntheticWorkbook } from '../fixtures/synthetic-workbook.js';
import { assertMarkerPresent, targetFrom } from '../isolated-target.mjs';
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
  writeWorkbookRows,
} from './declared-vocabularies-helpers.mjs';
import {
  engineFiles,
  errorOf,
  prepare,
  readiness,
  restReader,
} from './export-projection-helpers.mjs';
import { count, get, patch, post, remove } from './history-index-helpers.mjs';

// The declared vocabularies on a live project: setup installs every Flow
// family through one loop and keeps enum choices in step (refusing a
// stored value outside them), the one-time import seeds the academic years
// its workbook names, the published flag of a year decides its key in
// courses.json, and a mapping without a rule only warns.

const nothingToResume = () => Promise.resolve();
const laterYear = '2026/2027';
const sixteenYears = [laterYear, ...academicYears];
const entries = 'moodle_course_entries';
const reviewState = 'review_state';
const clock = () => '2026-09-23T12:00:00.000Z';
const oneValuePattern = /review_state holds 1 value\(s\)/u;
const deferredPattern = /"deferred"/u;
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

// review_state as an earlier version left it (without `ignored`): setup
// adds the value back and keeps the Studio note and width.
const realignsEnum = async ({ directus, target }) => {
  await driftEnum(target, {
    collection: entries,
    field: reviewState,
    values: ['needs_mapping', 'mapped'],
  });
  const ignored = { label: 'Synthetic ignored entry', review_state: 'ignored' };
  assert.equal(
    await refusedCreate(target, entries, ignored),
    'FAILED_VALIDATION',
  );
  const recorder = recording(directus);
  const summary = await installDataModel(recorder.request);
  assert.equal(summary.fields.aligned, 1);
  assert.deepEqual(recorder.mutations(), [
    { method: 'PATCH', pathname: `/fields/${entries}/${reviewState}` },
  ]);
  assert.ok(
    recorder.calls.some(
      ({ pathname }) =>
        pathname ===
        `/items/${entries}?aggregate[count]=*&groupBy[]=${reviewState}&limit=-1`,
    ),
  );
  const meta = await liveMeta(target, entries, reviewState);
  const declared = declaredChoices(entries, reviewState);
  assert.equal(meta.note, 'Synthetic Studio note');
  assert.equal(meta.width, 'full');
  assert.deepEqual(meta.options.choices, declared.options.choices);
  assert.deepEqual(
    meta.display_options.choices,
    declared.display_options.choices,
  );
  assert.deepEqual(meta.validation, declared.validation);
  const created = await post(target, `/items/${entries}`, ignored);
  assert.equal(created.data.review_state, 'ignored');
  await remove(target, `/items/${entries}/${created.data.id}`);
};

// A stored value the declaration no longer accepts stops setup before any
// write; clearing it lets the next run realign.
const refusesOutOfSet = async ({ directus, target }) => {
  const earlier = ['needs_mapping', 'mapped', 'ignored', 'deferred'];
  await driftEnum(target, {
    collection: entries,
    field: reviewState,
    values: earlier,
  });
  const deferred = await post(target, `/items/${entries}`, {
    label: 'Synthetic deferred entry',
    review_state: 'deferred',
  });
  const recorder = recording(directus);
  await assert.rejects(runSetup(recorder.request), (error) => {
    assert.ok(error instanceof SchemaRefusalError);
    assert.match(error.message, oneValuePattern);
    assert.match(error.message, deferredPattern);
    assert.equal(error.summary.fields.refused, 1);
    return true;
  });
  assert.deepEqual(recorder.mutations(), []);
  const kept = await liveMeta(target, entries, reviewState);
  assert.deepEqual(kept.validation, { review_state: { _in: earlier } });
  await remove(target, `/items/${entries}/${deferred.data.id}`);
  const summary = await installDataModel(directus);
  assert.equal(summary.fields.aligned, 1);
  assert.equal(
    await refusedCreate(target, entries, {
      label: 'Synthetic deferred entry',
      review_state: 'deferred',
    }),
    'FAILED_VALIDATION',
  );
  assert.equal(declaredEnum(entries, reviewState).choices.length, 3);
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
  assert.deepEqual(previewBlockers(content), {});
  await writeWorkbookRows(target, content.data);
  const conversion = await convertWorkbook(directus, content, {
    batchSize: 250,
    now: clock,
    resume: false,
    runToken: 'declared-vocabularies',
  });
  assert.equal(conversion.status, 'converted');
  assert.equal(conversion.unresolved.unknown_academic_year, undefined);
  const courses = await count(target, 'courses');
  assert.equal(conversion.written.academic_years, 16);
  assert.equal(conversion.written.course_enrollment_rules, courses * 16);
  assert.deepEqual(
    await get(
      target,
      '/items/academic_years?fields=label,published,sort&sort=-sort&limit=-1',
    ),
    sixteenYears.map((label, index) => ({
      label,
      published: true,
      sort: 16 - index,
    })),
  );
  const later = await get(
    target,
    `/items/course_enrollment_rules?fields=id,pattern&filter[academic_year][label][_eq]=${encodeURIComponent(laterYear)}&limit=-1`,
  );
  assert.equal(later.length, courses);
  assert.ok(later.some(({ pattern }) => pattern === 'Synthetic Later Line'));
  // The upgrade path (npm run migrate) now converts the same sixteen years,
  // with no unknown-year finding.
  const upgrade = preflight(await readInventory(directus, {}), null);
  assert.deepEqual(upgrade.academicYears, sixteenYears);
  assert.deepEqual(
    upgrade.warnings.filter(({ code }) => code === 'unknown_academic_year'),
    [],
  );
  const settled = await settle(target, { limitMs: 180_000 });
  t.diagnostic(
    `converted ${JSON.stringify(conversion.written)}; settled after ${settled.elapsedMs} ms`,
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

// Two published years sharing a sort have no newest-first key order: a
// blocker that holds back courses.json until the sort is corrected.
const blocksSharedSort = async ({ target }) => {
  await setYear(target, laterYear, { sort: 15 });
  const shared = await readiness(target);
  assert.equal(shared.ready, false);
  assert.equal(shared.issueCounts.academic_year_sort_shared, 1);
  assert.deepEqual(shared.blockers, ['academic_year_sort_shared']);
  assert.deepEqual(shared.blockedFiles, ['courses.json']);
  assert.equal(
    shared.links.academic_year_sort_shared,
    '/admin/content/academic_years',
  );
  const run = await prepare(target);
  assert.equal(run.status, 409, JSON.stringify(run.body));
  assert.equal(errorOf(run.body).code, 'EXPORT_NOT_READY');
  await setYear(target, laterYear, { sort: 16 });
  const restored = await readiness(target);
  assert.equal(restored.ready, true, JSON.stringify(restored));
  assert.equal(restored.issueCounts.academic_year_sort_shared, 0);
};

// A mapping whose course and (unpublished) year have no rule is counted
// by nothing: a warning with its page, and the files still prepare.
const warnsUnruledMapping = async ({ state, target }) => {
  const year = await post(target, '/items/academic_years', {
    label: '2027/2028',
    sort: 17,
  });
  assert.equal(year.data.published, false);
  const entry = await post(target, `/items/${entries}`, {
    label: 'Synthetic unruled line',
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
  assert.equal(answer.issueCounts.mapping_without_rule, 1);
  assert.ok(answer.warnings.includes('mapping_without_rule'));
  assert.equal(
    answer.links.mapping_without_rule,
    '/admin/content/moodle_course_mappings',
  );
  assert.equal(answer.issueCounts.mapped_entry_awaiting_review, 1);
  assert.deepEqual(answer.blockers, []);
  assert.deepEqual(
    Object.keys(answer.issueCounts),
    readinessRegistry.map(({ code }) => code),
  );
  const run = await prepare(target);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.ok(run.body.warnings.includes('mapping_without_rule'));
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
          'imports a workbook with a 16th academic year and its rules',
          () => importsSixteenYears(context),
        );
        await t.test(
          'publishes exactly one more key per course for a published year',
          () => followsPublished(context),
        );
        await t.test('blocks two published years that share a sort', () =>
          blocksSharedSort(context),
        );
        await t.test(
          'warns about a mapping without a rule and still prepares the files',
          () => warnsUnruledMapping(context),
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
