import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';

import brandingSettings from '../directus/branding/settings.json' with { type: 'json' };
import { applyBranding } from '../src/branding.js';
import { createDirectusRequest } from '../src/directus-request.js';
import { publishAssetsFlowId } from '../src/flows/publish-public-assets.js';
import { runImportCli } from '../src/import-run.js';
import { exitCodes } from '../src/lifecycle.js';
import { runSetup } from '../src/setup.js';
import {
  installedCounts,
  oracleCounts,
  patternsOf,
  seedMappings,
  snapshotFor,
  staffFreeFor,
} from './fixture-seed.mjs';
import { yearRows } from './fixtures/stress-fixture.js';
import { syntheticWorkbook } from './fixtures/synthetic-workbook.js';
import {
  importsSnapshot,
  liveFiles,
  uploadSnapshot,
} from './publish-workflow-helpers.mjs';
import { parityDataset } from './relational-export-helpers.js';
import {
  settle,
  waitForStatus,
} from './relational/automatic-processing-helpers.mjs';
import { pauseAutomaticProcessing } from './relational/data-model-helpers.mjs';
import { readiness } from './relational/export-projection-helpers.mjs';
import {
  get,
  patch,
  post,
  remove,
  status,
} from './relational/history-index-helpers.mjs';

// The source project of the restore rehearsal (restore.integration.mjs),
// built on the isolated fixture through the supported paths: `npm run
// setup`, a one-time import of a generated workbook and a generated
// Moodle snapshot through the installed import Flow. Then what a real
// project accumulates in its database and uploads: the publish Flow
// edited in Studio, a bookmark, the branding with its files, a user who
// signs in with a password, source edits the schedule processes, and one
// source edit still pending when the backup is taken. The state the
// restore must reproduce is recorded as digests and counts; nothing is
// printed. The fixture is returned to marker-only afterwards.

const appearanceFields = [
  ...Object.keys(brandingSettings),
  'project_logo',
  'public_background',
  'public_favicon',
  'public_foreground',
];
const labelsPerPair = 1.25;
const studioColor = '#2ECDA7';
// The source edit renames one course; the bookmark lists what it renamed.
export const renamedSuffix = '(renamed)';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The appearance settings the branding writes.
export const appearanceOf = (target) =>
  get(target, `/settings?fields=${appearanceFields.join(',')}`);

// The project block of the public server information (login page).
export const serverProjectOf = async (target) => {
  const response = await fetch(new URL('/server/info', target.base), {
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  return data.project;
};

// Every file of the local storage location, by id, as its bytes digest.
export const localFilesOf = async (target) => {
  const files = await get(
    target,
    '/files?fields=id,filesize&filter[storage][_eq]=local&sort=id&limit=-1',
  );
  const digests = {};
  for (const { filesize, id } of files) {
    const response = await fetch(new URL(`/assets/${id}`, target.base), {
      headers: { authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(60_000),
    });
    assert.equal(response.status, 200, `asset ${id}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    digests[id] = { bytes: bytes.length, filesize, sha256: sha256(bytes) };
  }
  return digests;
};

// A Flow with its operations, as Studio edits them.
export const flowOf = async (target, id) => {
  const [flow] = await get(
    target,
    `/flows?fields=id,name,description,icon,color,status,trigger,accountability,options,operation&filter[id][_eq]=${id}`,
  );
  const operations = await get(
    target,
    `/operations?fields=id,key,name,type,position_x,position_y,options,resolve,reject&filter[flow][_eq]=${id}&sort=id&limit=-1`,
  );
  return { flow, operations };
};

export const presetOf = async (target, id) => {
  const [preset] = await get(
    target,
    `/presets?fields=id,bookmark,collection,color,filter,icon,layout,layout_query,role,user&filter[id][_eq]=${id}`,
  );
  return preset ?? null;
};

// The state a restore must reproduce, as digests and counts.
const projectState = async ({ state, target }) => ({
  appearance: await appearanceOf(target),
  counts: Object.fromEntries(await installedCounts(target, state.seeded)),
  export: await liveFiles(target),
  files: await localFilesOf(target),
  flow: await flowOf(target, publishAssetsFlowId),
  preset: await presetOf(target, state.presetId),
  project: await serverProjectOf(target),
});

const importsWorkbook = async ({ state, target }) => {
  const workbook = path.join(state.dir, 'synthetic.xlsx');
  await syntheticWorkbook(parityDataset()).xlsx.writeFile(workbook);
  const errors = [];
  const summary = [];
  const exitCode = await runImportCli(
    [],
    {
      DIRECTUS_TOKEN: target.token,
      DIRECTUS_URL: target.base.href,
      WORKBOOK_PATH: workbook,
    },
    {
      createRequest: createDirectusRequest,
      stderr: (line) => {
        errors.push(line);
      },
      stdout: (line) => {
        summary.push(line);
      },
    },
  );
  assert.equal(exitCode, exitCodes.ok, errors.join('\n'));
  assert.deepEqual(JSON.parse(summary[0] ?? '{}').blockers, {});
};

// Setup, the generated workbook, one newer academic year (unpublished)
// and the generated snapshot of the created courses and years, settled.
export const buildsProject = async (context) => {
  const { declarations, directus, size, state, t, target } = context;
  const setup = await runSetup(directus);
  await importsWorkbook(context);
  const years = await get(
    target,
    '/items/academic_years?fields=id,label&sort=label&limit=-1',
  );
  const next = yearRows(years.map(({ label }) => label)).at(-1);
  await post(target, '/items/academic_years', {
    label: next.label,
    published: false,
  });
  const courses = await get(
    target,
    '/items/courses?fields=id,name&sort=id&limit=-1',
  );
  const seeded = {
    courses: courses.map(({ id, name }, index) => ({ id, index, name })),
    years: await get(
      target,
      '/items/academic_years?fields=id,label,published&sort=label&limit=-1',
    ),
  };
  const pairs = seeded.courses.length * seeded.years.length;
  Object.assign(state, {
    newYear: seeded.years.findIndex(({ label }) => label === next.label),
    seeded,
    snapshotRows: snapshotFor(declarations, seeded, {
      labels: Math.ceil(pairs * labelsPerPair),
      users: size.users,
    }),
  });
  const file = await uploadSnapshot(context, { name: 'restore-snapshot' });
  const answer = await importsSnapshot(context, file);
  const settled = await settle(target, { limitMs: 300_000 });
  t.diagnostic(
    `setup created ${setup.flows.created.length} Flows; imported the workbook (${seeded.courses.length} courses, ${seeded.years.length} years with one unpublished) and ${answer.rows} snapshot rows; settled after ${settled.elapsedMs} ms`,
  );
};

// What a real project accumulates: the branding and its files, the
// publish Flow edited in Studio, a bookmark, a password user and two
// source edits, settled.
export const customizesProject = async (context) => {
  const { directus, state, target } = context;
  state.fixtureAppearance = await appearanceOf(target);
  await applyBranding(directus);
  state.flowTemplate = await flowOf(target, publishAssetsFlowId);
  const { flow, operations } = state.flowTemplate;
  const claim = operations.find(({ key }) => key === 'claim');
  await patch(target, `/flows/${flow.id}`, {
    color: studioColor,
    description: `${flow.description} Edited in Studio for the restore rehearsal.`,
    options: {
      ...flow.options,
      confirmationDescription:
        'Synthetic restore rehearsal: publish every declared file?',
    },
  });
  await patch(target, `/operations/${claim.id}`, {
    name: `${claim.name} (edited in Studio)`,
    position_x: claim.position_x + 2,
  });
  const preset = await post(target, '/presets', {
    bookmark: 'Synthetic restore bookmark',
    collection: 'courses',
    color: studioColor,
    filter: { name: { _contains: renamedSuffix } },
    icon: 'bookmark',
    layout: 'tabular',
    layout_query: { tabular: { fields: ['name'], sort: ['name'] } },
  });
  state.presetId = preset.data.id;
  const [role] = await get(
    target,
    '/roles?fields=id&filter[name][_eq]=Administrator&limit=1',
  );
  state.login = {
    email: `restore-admin-${randomUUID()}@example.com`,
    password: randomBytes(24).toString('hex'),
  };
  const user = await post(target, '/users', {
    ...state.login,
    first_name: 'Synthetic',
    last_name: 'Restore Administrator',
    role: role.id,
    status: 'active',
  });
  state.userId = user.data.id;
  const [assignment] = await get(
    target,
    '/items/teaching_assignments?fields=id,course,role&sort=id&limit=1',
  );
  const next = await staffFreeFor(target, assignment);
  await patch(target, `/items/teaching_assignments/${assignment.id}`, {
    staff: next.id,
  });
  const [course] = state.seeded.courses;
  await patch(target, `/items/courses/${course.id}`, {
    name: `${course.name} ${renamedSuffix}`,
  });
  await settle(target, { limitMs: 120_000 });
};

// The state the backup must reproduce, once readiness passes.
export const recordsState = async (context) => {
  const answer = await readiness(context.target);
  assert.equal(answer.ready, true, JSON.stringify(answer.blockers));
  const before = await projectState(context);
  Object.assign(context.state, { before });
  context.t.diagnostic(
    `recorded ${Object.keys(before.export).length} declared files, ${Object.keys(before.counts).length} counts, ${Object.keys(before.files).length} local files`,
  );
};

// The schedule paused, the labels of the newer year are mapped by hand: an
// edit the backup takes while it is still pending.
export const leavesEditPending = async (context) => {
  const { state, target } = context;
  state.resumeSchedule = await pauseAutomaticProcessing(target);
  await waitForStatus(target, (current) => current.claim === null);
  state.patterns = await patternsOf(target, state.seeded);
  state.mappings = await seedMappings(target, {
    labels: state.snapshotRows.labels,
    seeded: state.seeded,
    year: state.newYear,
  });
  const report = await status(target);
  assert.equal(report.claim, null);
  assert.equal(report.domains.enrollments.current, false);
  state.pending = { revisions: report.revisions };
};

// The counts of the newer year the pending edit must reach: the oracle
// over the import's pattern mappings and the explicit mappings.
export const newYearCounts = (state) =>
  [...oracleCounts(state)].filter(([key]) =>
    key.endsWith(`/${String(state.newYear)}`),
  );

// Puts the publish Flow and its edited operation back as the template
// installed them.
const restoresFlowTemplate = async (target, template) => {
  const { flow, operations } = template;
  await patch(target, `/flows/${flow.id}`, {
    color: flow.color,
    description: flow.description,
    options: flow.options,
  });
  const current = await flowOf(target, flow.id);
  const edited = operations.filter((operation) => {
    const now = current.operations.find(({ id }) => id === operation.id);
    return (
      now?.name !== operation.name || now.position_x !== operation.position_x
    );
  });
  for (const operation of edited) {
    await patch(target, `/operations/${operation.id}`, {
      name: operation.name,
      position_x: operation.position_x,
    });
  }
  assert.deepEqual(await flowOf(target, flow.id), template);
};

// Removes every row of a listing that was not there before the run.
const removesNew = async (target, collection, before) => {
  const rows = await get(target, `/${collection}?fields=id&limit=-1`);
  for (const { id } of rows) {
    if (!before.has(id)) await remove(target, `/${collection}/${id}`);
  }
};

// Undoes on the fixture what the run added beside the model collections:
// the publish Flow and its operation back to the template, the bookmark,
// the user, the appearance settings, and every file and Flow the run
// created.
export const revertsFixture = async ({ state, target }) => {
  if (state.flowTemplate) {
    await restoresFlowTemplate(target, state.flowTemplate);
  }
  if (state.presetId) await remove(target, `/presets/${state.presetId}`);
  if (state.userId) await remove(target, `/users/${state.userId}`);
  if (state.fixtureAppearance) {
    await patch(target, '/settings', state.fixtureAppearance);
  }
  await removesNew(target, 'files', state.filesBefore);
  await removesNew(target, 'flows', state.flowsBefore);
};
