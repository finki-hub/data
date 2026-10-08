import assert from 'node:assert/strict';

import { exportDefinitions } from '../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { publishFlows } from '../src/flows/publish-public-assets.js';
import { runSetup } from '../src/setup.js';
import {
  entryIds,
  installedCounts,
  seedReference,
  snapshotFor,
  staffFreeFor,
} from './fixture-seed.mjs';
import { indexOf } from './fixtures/stress-snapshot.js';
import {
  assertIntact,
  digestsOf,
  importsSnapshot,
  publishedRows,
  publishes,
  settlesCounted,
  snapshotState,
  uploadSnapshot,
} from './publish-workflow-helpers.mjs';
import { readiness } from './relational/export-projection-helpers.mjs';
import { count, get, patch } from './relational/history-index-helpers.mjs';

// The accepted path of the complete workflow suite: setup, the generated
// reference rows through the REST API, the unchanged generated CSV through
// staging and promotion, the counts of the native schedule against the
// oracle, readiness and the manual publication, and a relation change
// that reaches the published JSON.

const coursesFile = exportDefinitions.find(
  ({ rows }) => rows.collection === 'courses',
)?.filename;

export const setsUp = async ({ directus, t }) => {
  const summary = await runSetup(directus);
  const flows = new Set([...summary.flows.created, ...summary.flows.skipped]);
  for (const flow of publishFlows) {
    assert.ok(flows.has(flow.name), flow.name);
  }
  t.diagnostic(
    `setup: ${summary.flows.created.length} Flows created, ${summary.flows.skipped.length} kept`,
  );
};

export const seeds = async (context) => {
  const { declarations, size, state, t, target } = context;
  const seeded = await seedReference(target, declarations, {
    courses: size.courses,
    referenceRows: size.referenceRows,
  });
  Object.assign(state, {
    mappings: [],
    rules: seeded.rules,
    seeded,
    snapshotRows: snapshotFor(declarations, seeded, size),
  });
  t.diagnostic(
    `seeded ${seeded.courses.length} courses, ${seeded.years.length} years, ${seeded.generations.length} generations, ${seeded.programs.length} programs, ${seeded.curriculum.entries.length} entries, ${seeded.assignments.length} assignments, ${seeded.rules.length} rules`,
  );
};

export const importsUnchangedCsv = async (context) => {
  const { state, t, target } = context;
  const file = await uploadSnapshot(context, { name: 'workflow-snapshot' });
  const answer = await importsSnapshot(context, file);
  assert.equal(answer.previousRows, 0);
  assert.ok(answer.pending.includes('history_index'));
  Object.assign(state, {
    snapshot: await snapshotState(target),
    snapshotFile: file,
  });
  t.diagnostic(
    `imported ${answer.rows} rows through staging and promotion; pending ${answer.pending.join(', ')}`,
  );
};

// The schedule indexes every distinct history line once per user and
// counts every rule's pair exactly as the oracle does.
export const countsAutomatically = async (context) => {
  const { state, t, target } = context;
  const settled = await settlesCounted(context, 'after the import');
  const index = indexOf(state.snapshotRows.lines);
  assert.equal(
    await count(target, 'moodle_history_memberships'),
    index.memberships,
  );
  const entries = await entryIds(target);
  assert.equal(entries.size, index.labels.size);
  assert.ok([...index.labels].every((label) => entries.has(label)));
  t.diagnostic(
    `indexed ${index.labels.size} entries, ${index.memberships} memberships; ${state.rules.length} pairs counted; settled after ${settled.elapsedMs} ms`,
  );
};

// Readiness passes and the manual publish writes every declared file;
// each published year key of courses.json carries the installed count.
export const publishesManually = async (context) => {
  const { state, t, target } = context;
  const answer = await readiness(target);
  assert.equal(answer.ready, true, JSON.stringify(answer.blockers));
  const run = await publishes(context);
  const counts = await installedCounts(target, state.seeded);
  const rows = publishedRows(state.objects, coursesFile);
  assert.equal(rows.length, state.seeded.courses.length);
  for (const [courseIndex, course] of state.seeded.courses.entries()) {
    const row = rows.find(({ name }) => name === course.name);
    for (const [yearIndex, year] of state.seeded.years.entries()) {
      const value = row?.[year.label];
      const expected = year.published
        ? String(counts.get(`${courseIndex}/${yearIndex}`))
        : undefined;
      assert.equal(value, expected, 'a published year key carries its count');
    }
  }
  t.diagnostic(
    `published revision ${run.revision}: ${JSON.stringify(digestsOf(state.objects))}`,
  );
};

// The professor of a course is reassigned to another staff member (a
// relation, not a copied value): the next publication changes exactly
// that course's professors in courses.json and nothing else.
export const publishesRelationChange = async (context) => {
  const { state, t, target } = context;
  const before = publishedRows(state.objects, coursesFile);
  const [assignment] = await get(
    target,
    '/items/teaching_assignments?fields=id,course,role&filter[role][_eq]=professor&sort=id&limit=1',
  );
  const next = await staffFreeFor(target, assignment);
  await patch(target, `/items/teaching_assignments/${assignment.id}`, {
    staff: next.id,
  });
  await assertIntact(context, 'before the relation change is published');
  const digests = digestsOf(state.objects);
  await publishes(context);
  const after = publishedRows(state.objects, coursesFile);
  const course = state.seeded.courses.find(
    ({ id }) => id === assignment.course,
  );
  const changed = after.flatMap((row, index) =>
    Object.keys({ ...row, ...before[index] })
      .filter((key) => row[key] !== before[index]?.[key])
      .map((key) => `${row.name}:${key}`),
  );
  assert.deepEqual(changed, [`${course.name}:professors`]);
  assert.ok(
    after
      .find(({ name }) => name === course.name)
      ?.professors?.includes(next.name),
  );
  const others = Object.entries(digestsOf(state.objects)).filter(
    ([key, digest]) => key !== coursesFile && digest !== digests[key],
  );
  assert.deepEqual(others, []);
  t.diagnostic('a reassigned professor reached courses.json alone');
};
