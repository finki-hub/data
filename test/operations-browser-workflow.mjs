import assert from 'node:assert/strict';
import path from 'node:path';

import { declaredFilenames } from '../directus/extensions/directus-extension-data-operations/src/coordination/outcomes.js';
import { exportDefinitions } from '../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { publishAssetsFlowId } from '../src/flows/publish-public-assets.js';
import { snapshotFlowId } from '../src/flows/snapshot-import.js';
import {
  clickMatching,
  pickInDrawer,
  textOf,
  waitUntil,
} from './operations-browser-helpers.mjs';
import { readObject, trigger } from './publish-flow-helpers.mjs';
import { createMany } from './relational/automatic-processing-helpers.mjs';
import { readiness } from './relational/export-projection-helpers.mjs';
import { count, get } from './relational/history-index-helpers.mjs';
import {
  snapshotPath,
  syntheticRows,
  uploadCsv,
  writeSnapshot,
} from './relational/snapshot-import-helpers.mjs';

// The workflow steps of test/operations.browser.mjs (Task 18): a relation
// edited natively in Studio's item form reaches the published JSON through
// the dashboard's Publish, and a malformed snapshot imported from the
// dashboard leaves the active snapshot and every published object as they
// were. Everything is synthetic.

const coursesFile =
  exportDefinitions.find(({ rows }) => rows.collection === 'courses')
    ?.filename ?? '';
const staffNames = [
  'Synthetic Browser Lecturer A',
  'Synthetic Browser Lecturer B',
];
const malformedTitle = 'synthetic-browser-malformed';
const dialogs = '#dialog-outlet';

const professorsOf = async (s3, courseName) => {
  const object = await readObject(s3, coursesFile);
  const rows = JSON.parse(object?.body ?? '[]');
  return rows.find(({ name }) => name === courseName)?.professors;
};

// Two synthetic staff members and a professor assignment of the first
// course to the first of them, published over REST as the starting point.
const seedsAssignment = async ({ s3, state, target }) => {
  const staff = await createMany(
    target,
    'staff',
    staffNames.map((name) => ({ active: true, name })),
  );
  const [course] = await get(
    target,
    `/items/courses?fields=id,name&filter[id][_eq]=${state.courses[0]}`,
  );
  const [assignment] = await createMany(target, 'teaching_assignments', [
    {
      course: course.id,
      course_name: course.name,
      role: 'professor',
      sort: 1,
      staff: staff[0],
    },
  ]);
  const run = await trigger(target, publishAssetsFlowId);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(await professorsOf(s3, course.name), staffNames[0]);
  return { assignment, course };
};

// The assignment's Staff is changed in Studio's item form through the
// native relation picker and saved; Publish on the dashboard then writes
// the new name into courses.json.
export const editsRelationNatively = async (context) => {
  const { admin, openDashboard, runFromPanel, s3, shot, target } = context;
  const { assignment, course } = await seedsAssignment(context);
  await admin.command(
    'open',
    new URL(`/admin/content/teaching_assignments/${assignment}`, target.base)
      .href,
  );
  await admin.command('wait', '--text', staffNames[0]);
  await admin.command('wait', '--load', 'networkidle');
  await shot(admin, '17-assignment-before.png');
  await pickInDrawer(admin, {
    picker: (line) => line.includes(staffNames[0]),
    text: staffNames[1],
  });
  await admin.command('wait', '--text', staffNames[1]);
  await shot(admin, '18-assignment-picked.png');
  await clickMatching(admin, (line) => line.includes('button "Save"'));
  await waitUntil('the saved assignment', async () => {
    const [row] = await get(
      target,
      `/items/teaching_assignments?fields=staff.name&filter[id][_eq]=${assignment}`,
    );
    return row?.staff?.name === staffNames[1];
  });
  await openDashboard(admin, target);
  await runFromPanel(admin, publishAssetsFlowId);
  await waitUntil(
    'the publication answer',
    async () => {
      const text = await textOf(admin, `[data-flow="${publishAssetsFlowId}"]`);
      return text.includes('Finished.');
    },
    300_000,
  );
  assert.equal(await professorsOf(s3, course.name), staffNames[1]);
  await shot(admin, '19-relation-published.png');
};

// A snapshot whose last row is malformed, imported from the dashboard:
// the panel reports the refusal; the active users, the snapshot report and
// every published object are unchanged, and readiness names the failed
// import as a blocker.
export const keepsStateOnFailedImport = async (context) => {
  const {
    admin,
    openDashboard,
    pickItem,
    runFromPanel,
    s3,
    shot,
    state,
    target,
  } = context;
  const rows = syntheticRows(200, 40_000);
  const file = path.join(state.csvDirectory, 'malformed.csv');
  await writeSnapshot(
    file,
    rows,
    new Map([[rows.length - 1, '1,"Unterminated synthetic late row\n']]),
  );
  await uploadCsv(target, { file, state, title: malformedTitle });
  const users = await count(target, 'moodle_users');
  const report = await get(target, snapshotPath);
  const objects = await Promise.all(
    declaredFilenames.map((key) => readObject(s3, key)),
  );
  await openDashboard(admin, target);
  await runFromPanel(admin, snapshotFlowId, {
    fill: async () => {
      await pickItem(admin, malformedTitle);
      await clickMatching(admin, (line) => line.includes('checkbox'), dialogs);
    },
  });
  await waitUntil(
    'the refused import',
    async () => {
      const text = await textOf(admin, `[data-flow="${snapshotFlowId}"]`);
      return text.includes('SNAPSHOT_INVALID_CSV');
    },
    300_000,
  );
  await shot(admin, '20-import-refused.png');
  assert.equal(await count(target, 'moodle_users'), users);
  const after = await get(target, snapshotPath);
  assert.deepEqual(after.active, report.active);
  assert.equal(after.activeMatchesPromotion, report.activeMatchesPromotion);
  const now = await Promise.all(
    declaredFilenames.map((key) => readObject(s3, key)),
  );
  assert.deepEqual(
    now.map((object) => [object?.sha256, object?.lastModified]),
    objects.map((object) => [object?.sha256, object?.lastModified]),
  );
  const ready = await readiness(target);
  assert.equal(ready.ready, false);
  assert.ok(
    ready.blockers.includes('snapshot_import_failed'),
    JSON.stringify(ready.blockers),
  );
};
