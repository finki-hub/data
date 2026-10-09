import assert from 'node:assert/strict';

import { declaredFilenames } from '../directus/extensions/directus-extension-data-operations/src/coordination/outcomes.js';
import { exportDefinitions } from '../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import {
  createRows,
  installedCounts,
  seedCurriculum,
  seedMappings,
} from './fixture-seed.mjs';
import { expectedFiles } from './fixtures/stress-fixture.js';
import {
  assertCounts,
  digestsOf,
  keyRowsOf,
  publishedRows,
  publishes,
  settlesCounted,
} from './publish-workflow-helpers.mjs';
import {
  afterTick,
  dispatcherRuns,
  settle,
  wallClock,
} from './relational/automatic-processing-helpers.mjs';
import {
  collator,
  patch,
  remove,
  status,
} from './relational/history-index-helpers.mjs';

// The extension scenarios of the complete workflow suite: a new academic
// year and a new curriculum generation with two programs are rows, never
// code. Each reaches the published files only once it is opted in, and
// then adds exactly its declared keys.

const coursesFile =
  exportDefinitions.find(({ rows }) => rows.collection === 'courses')
    ?.filename ?? '';

// Publishing again must leave every object with the same bytes.
const publishesUnchanged = async (context, label) => {
  const before = digestsOf(context.state.objects);
  await publishes(context);
  assert.deepEqual(digestsOf(context.state.objects), before, label);
};

// The keys each courses.json row gained, and whether every other key and
// value stayed.
const gainedKeys = (before, after) => {
  assert.equal(after.length, before.length);
  return after.map((row, index) => {
    const old = before[index] ?? {};
    const kept = Object.fromEntries(
      Object.entries(row).filter(([key]) => Object.hasOwn(old, key)),
    );
    assert.deepEqual(kept, old, 'every earlier key and value stays');
    return Object.keys(row).filter((key) => !Object.hasOwn(old, key));
  });
};

// The unpublished newer year of the fixture is counted like every year.
// Explicit mappings of its lines are counted by exactly one run of the
// dispatcher on the next tick (written just after a tick, so no run meets
// half of them; no failure or overtaking recorded). The year changes no
// published byte until it is opted in, then adds one key per course: its
// label, before the older years, valued by the count.
export const extendsYear = async (context) => {
  const { state, t, target } = context;
  const position = state.seeded.years.findIndex(({ published }) => !published);
  const year = state.seeded.years[position];
  const before = await status(target);
  await assertCounts(context, 'the new year before it is published');
  await afterTick();
  const mappings = await seedMappings(target, {
    labels: state.snapshotRows.labels,
    seeded: state.seeded,
    year: position,
  });
  Object.assign(state, { mappings: [...state.mappings, ...mappings] });
  const since = wallClock();
  const settled = await settlesCounted(context, 'the new year after a tick');
  assert.equal(
    await dispatcherRuns(target, since, 1),
    1,
    'one count run on the next tick counted the new year',
  );
  assert.equal(
    settled.report.lastError?.at,
    before.lastError?.at,
    'no run failed or was overtaken',
  );
  await publishesUnchanged(context, 'an unpublished year places no key');
  const rows = publishedRows(state.objects, coursesFile);
  await patch(target, `/items/academic_years/${year.id}`, { published: true });
  await settlesCounted(context, 'the published year');
  const digests = digestsOf(state.objects);
  await publishes(context);
  const after = publishedRows(state.objects, coursesFile);
  const gained = gainedKeys(rows, after);
  assert.ok(
    gained.every((keys) => keys.length === 1 && keys[0] === year.label),
  );
  const counts = await installedCounts(target, state.seeded);
  // The newest other published year: YYYY/YYYY labels sort as their dates.
  const newest = state.seeded.years
    .filter(({ id, published }) => published && id !== year.id)
    .toSorted((left, right) => collator.compare(right.label, left.label))[0];
  for (const row of after) {
    const course = state.seeded.courses.findIndex(
      ({ name }) => name === row.name,
    );
    assert.equal(row[year.label], String(counts.get(`${course}/${position}`)));
    const keys = Object.keys(row);
    assert.equal(keys.indexOf(year.label) + 1, keys.indexOf(newest.label));
  }
  const others = declaredFilenames.filter(
    (key) =>
      key !== coursesFile && digests[key] !== digestsOf(state.objects)[key],
  );
  assert.deepEqual(others, []);
  t.diagnostic(
    `new year: ${mappings.length} explicit mappings counted by one dispatcher run, ${settled.elapsedMs} ms after the writes; one key per course once published`,
  );
};

// A test-only generation (the next code after the created ones) with two
// programs and entries for the courses: no published byte changes until
// the programs and then the generation are published; then courses.json
// gains exactly the keys the registry declares for it, and unpublishing
// and removing it restores every object.
export const extendsGeneration = async (context) => {
  const { state, t, target } = context;
  const code = String(
    Math.max(...state.seeded.generations.map((row) => Number(row.code))) + 5,
  );
  const [generation] = await createRows(target, 'curriculum_generations', [
    { code, has_curriculum: true, label: `Synthetic Curriculum ${code}` },
  ]);
  // Created in reverse code order: the state keys follow the code.
  const programRows = [
    { code: 'cd', generation, name: 'Synthetic CD' },
    { code: 'ab', generation, name: 'Synthetic AB' },
  ];
  const programIds = await createRows(target, 'study_programs', programRows);
  const curriculum = await seedCurriculum(target, {
    courses: state.seeded.courses,
    generations: [{ code, has_curriculum: true, id: generation }],
    programs: programRows.map((row, index) => ({
      ...row,
      id: programIds[index],
    })),
  });
  await settle(target);
  const original = digestsOf(state.objects);
  const before = publishedRows(state.objects, coursesFile);
  const keysBefore = expectedFiles(exportDefinitions, await keyRowsOf(target));
  await publishesUnchanged(context, 'an unpublished generation places no key');
  for (const id of programIds) {
    await patch(target, `/items/study_programs/${id}`, { published: true });
  }
  await publishesUnchanged(context, 'programs of an unpublished generation');
  await patch(target, `/items/curriculum_generations/${generation}`, {
    published: true,
  });
  await settle(target);
  await publishes(context);
  const keysAfter = expectedFiles(exportDefinitions, await keyRowsOf(target));
  const declared =
    keysAfter
      .find(({ filename }) => filename === coursesFile)
      ?.keys.filter(
        (key) =>
          !keysBefore
            .find(({ filename }) => filename === coursesFile)
            ?.keys.includes(key),
      ) ?? [];
  assert.ok(declared.length > 0);
  assert.ok(declared.every((key) => key.startsWith(`${code}-`)));
  assert.ok(
    declared.indexOf(`${code}-state-ab`) < declared.indexOf(`${code}-state-cd`),
  );
  const gained = gainedKeys(before, publishedRows(state.objects, coursesFile));
  const union = new Set(gained.flat());
  assert.ok(
    gained.every((keys) => keys.every((key) => declared.includes(key))),
  );
  assert.deepEqual(
    declared.filter((key) => union.has(key)),
    declared,
  );
  const others = declaredFilenames.filter((name) => name !== coursesFile);
  for (const key of others) {
    assert.equal(digestsOf(state.objects)[key], original[key], key);
  }
  await patch(target, `/items/curriculum_generations/${generation}`, {
    published: false,
  });
  for (const id of curriculum.links)
    await remove(target, `/items/course_curricula/${id}`);
  for (const id of curriculum.entries)
    await remove(target, `/items/curriculum_entries/${id}`);
  for (const id of programIds)
    await remove(target, `/items/study_programs/${id}`);
  await remove(target, `/items/curriculum_generations/${generation}`);
  await settle(target);
  await publishes(context);
  assert.deepEqual(digestsOf(state.objects), original);
  t.diagnostic(
    `generation ${code} with 2 programs: ${declared.length} declared keys once published, none before; removed again`,
  );
};
