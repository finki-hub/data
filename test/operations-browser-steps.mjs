import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { declaredFilenames } from '../directus/extensions/directus-extension-data-operations/src/coordination/outcomes.js';
import {
  defaultPanels,
  operationsDashboardId,
} from '../src/data-model/operations-dashboard.js';
import { publishAssetsFlowId } from '../src/flows/publish-public-assets.js';
import { snapshotFlowId } from '../src/flows/snapshot-import.js';
import {
  clickMatching,
  entryText,
  pickInDrawer,
  refIn,
  stopRecording,
  textOf,
  tickedBoxes,
  waitUntil,
} from './operations-browser-helpers.mjs';
import {
  deleteObject,
  listKeys,
  probeChildId,
  probeParentId,
} from './publish-flow-helpers.mjs';
import {
  createMany,
  installFlow,
  operationOf,
  removeFlow,
} from './relational/automatic-processing-helpers.mjs';
import { get, patch, remove } from './relational/history-index-helpers.mjs';
import {
  syntheticRows,
  uploadCsv,
  writeSnapshot,
} from './relational/snapshot-import-helpers.mjs';

// The longer steps of test/operations.browser.mjs: the synthetic rows, the
// publication, a panel added for a new manual Flow, the editor's visit,
// the privacy check of the browser logs and the cleanup.

const yearLabel = '2095/2096';
const syntheticFlowId = '9e4d826c-5b1a-4c0e-8f2d-000000001601';
const syntheticFlowName = 'Data / Synthetic QA action';
const syntheticNote = 'Synthetic QA note';
const privateMarks = ['snapshot.example', 'Synthetic Student', 'Синтетички'];
const dialogs = '#dialog-outlet';
// The first grid row below the default panels.
const freeRow = Math.max(...defaultPanels.map(({ height, y }) => y + height));

// Three courses, a new unpublished academic year and a generated snapshot
// CSV of synthetic users uploaded into the private folder.
export const seedRows = async (
  target,
  state,
  { snapshotRows, snapshotTitle },
) => {
  const files = await get(target, '/files?fields=id&limit=-1');
  state.fileIdsBefore = new Set(files.map(({ id }) => id));
  const courses = await createMany(target, 'courses', [
    { name: 'Synthetic Browser Course A' },
    { name: 'Synthetic Browser Course B' },
    { name: 'Synthetic Browser Course C' },
  ]);
  const [year] = await createMany(target, 'academic_years', [
    { label: yearLabel, published: false, sort: 95 },
  ]);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'operations-browser-csv-'),
  );
  const file = path.join(directory, 'snapshot.csv');
  await writeSnapshot(file, syntheticRows(snapshotRows));
  await uploadCsv(target, { file, state, title: snapshotTitle });
  return {
    courses,
    csvDirectory: directory,
    // A source edit that leaves publication pending.
    rename: (suffix) =>
      patch(target, `/items/courses/${courses[0]}`, {
        name: `Synthetic Browser Course A ${suffix}`,
      }),
    yearId: year,
    yearLabel,
  };
};

export const publishStep = async ({
  admin,
  openDashboard,
  runFromPanel,
  s3,
  shot,
  target,
}) => {
  await openDashboard(admin, target);
  await runFromPanel(admin, publishAssetsFlowId);
  await waitUntil(
    'the publication answer',
    async () => {
      const text = await textOf(admin, `[data-flow="${publishAssetsFlowId}"]`);
      return text.includes('Succeeded');
    },
    300_000,
  );
  const report = await get(target, '/finki-hub-data-status');
  assert.equal(report.publication.state, 'completed');
  assert.deepEqual(
    report.publication.files.map(({ outcome }) => outcome),
    declaredFilenames.map(() => 'uploaded'),
  );
  const keys = new Set(await listKeys(s3));
  assert.deepEqual(
    declaredFilenames.filter((key) => !keys.has(key)),
    [],
  );
  await admin.command('wait', '--text', 'Uploaded');
  await shot(admin, '05-publish-completed.png');
};

const syntheticFlow = {
  accountability: 'activity',
  description: 'Synthetic QA action of the browser suite; removed by it.',
  icon: 'science',
  id: syntheticFlowId,
  name: syntheticFlowName,
  options: {
    async: false,
    collections: ['data_operations'],
    confirmationDescription: 'Run the synthetic QA action with this note?',
    error_on_reject: true,
    fields: [
      {
        field: 'note',
        meta: { interface: 'input', required: true, width: 'full' },
        name: 'Note',
        type: 'string',
      },
      {
        field: 'flag',
        meta: { interface: 'boolean', width: 'full' },
        name: 'Flag',
        type: 'boolean',
      },
    ],
    location: 'both',
    requireConfirmation: true,
    requireSelection: false,
  },
  trigger: 'manual',
};

// An administrator puts a Run operation panel for a Flow created after the
// build on the dashboard in Studio; it renders the Flow's own fields.
export const addsPanel = async ({
  admin,
  openDashboard,
  runFromPanel,
  shot,
  target,
}) => {
  await installFlow(target, syntheticFlow, [
    operationOf({
      id: '9e4d826c-5b1a-4c0e-8f2d-000000001602',
      key: 'answer',
      options: { json: { note: '{{ $trigger.body.note }}', ok: true } },
      type: 'transform',
    }),
  ]);
  await openDashboard(admin, target);
  await admin.command(
    'find',
    'role',
    'button',
    'click',
    '--name',
    'Edit Panels',
  );
  await clickMatching(admin, (line) => line.includes('link "Create Panel"'));
  await admin.command('wait', '--text', 'Run operation');
  await clickMatching(admin, (line) =>
    line.includes('"play_circle Run operation"'),
  );
  await pickInDrawer(admin, {
    picker: (line) => line.includes('"Select an item... expand_more"'),
    scope: dialogs,
    text: syntheticFlowName,
  });
  const drawer = await admin.command('snapshot', '-i', '-s', dialogs);
  await admin.command(
    'fill',
    refIn(drawer, (line) => line.includes('textbox "Name this panel..."')),
    'Synthetic QA action',
  );
  await shot(admin, '09-new-panel-options.png');
  await clickMatching(admin, (line) => line.includes('button "Done"'), dialogs);
  await clickMatching(
    admin,
    (line) => line.includes('button "Save"') && !line.includes('disabled'),
  );
  await admin.command('wait', `[data-flow="${syntheticFlowId}"] .run button`);
  let saved;
  await waitUntil('the saved panel', async () => {
    const panels = await get(
      target,
      `/panels?fields=id,options&filter[dashboard][_eq]=${operationsDashboardId}&limit=-1`,
    );
    saved = panels.find(
      ({ options }) => options?.flow?.key === syntheticFlowId,
    );
    return saved !== undefined;
  });
  // Studio places a new panel at 1,1, over the first default panel; the
  // administrator would drag it to a free place, done here over REST.
  await patch(target, `/panels/${saved.id}`, {
    position_x: 1,
    position_y: freeRow,
  });
  await openDashboard(admin, target);
  await runFromPanel(admin, syntheticFlowId, {
    fill: async () => {
      const dialog = await admin.command('snapshot', '-i', '-s', dialogs);
      assert.ok(dialog.includes('Note') && dialog.includes('Flag'), dialog);
      await shot(admin, '10-new-panel-dialog.png');
      await clickMatching(admin, (line) => line.includes('textbox'), dialogs);
      await admin.command('keyboard', 'type', syntheticNote);
    },
  });
  await waitUntil('the synthetic answer', async () => {
    const text = await textOf(admin, `[data-flow="${syntheticFlowId}"]`);
    return text.includes(syntheticNote);
  });
  await shot(admin, '11-new-panel-finished.png');
  const added = await get(
    target,
    `/panels?fields=id,options&filter[dashboard][_eq]=${operationsDashboardId}&limit=-1`,
  );
  for (const { id, options } of added) {
    if (options?.flow?.key === syntheticFlowId)
      await remove(target, `/panels/${id}`);
  }
  await removeFlow(target, syntheticFlowId);
};

// While the status read fails, a Run panel waits and names the failed
// read (never "Administrators only" to an administrator), and reads the
// status again on its own once it answers.
export const waitsForStatus = async ({
  admin,
  openDashboard,
  panel,
  runButton,
  shot,
  target,
}) => {
  const status = '**/finki-hub-data-status';
  const publish = panel(publishAssetsFlowId);
  await admin.command('network', 'route', status, '--abort');
  try {
    await openDashboard(admin, target);
    await waitUntil('the Run panel to say why it waits', async () => {
      const shown = await textOf(admin, publish);
      return shown.includes('Data status read failed: NO_ANSWER');
    });
    // The Flow's own description names its rule ("Administrators only.");
    // no state line of the panel may say it to an administrator.
    const said = await textOf(admin, publish);
    const described = await textOf(admin, `${publish} .description`);
    assert.ok(described.includes('Administrators only.'), described);
    assert.ok(
      !said.replace(described, '').includes('Administrators only'),
      said,
    );
    const enabled = await admin.attempt(
      'is',
      'enabled',
      runButton(publishAssetsFlowId),
    );
    assert.equal(enabled.stdout.trim(), 'false', 'Run waits for the status');
    await shot(admin, '15-status-unreadable.png');
  } finally {
    await admin.command('network', 'unroute', status);
  }
  await waitUntil(
    'Run to follow the status again without a reload',
    async () => {
      const enabled = await admin.attempt(
        'is',
        'enabled',
        runButton(publishAssetsFlowId),
      );
      return enabled.stdout.trim() === 'true';
    },
    // The pause after failed reads doubles up to one minute.
    90_000,
  );
};

// After the finished import, the next Run opens the Flow's dialog empty:
// no file picked (so the dialog's Run waits for one) and no box ticked.
export const reopensEmpty = async ({
  admin,
  confirmButton,
  openRunDialog,
  shot,
}) => {
  await openRunDialog(admin, snapshotFlowId);
  const dialog = await admin.command('snapshot', '-i', '-s', dialogs);
  const boxes = dialog.split('\n').filter((line) => line.includes('checkbox'));
  assert.ok(dialog.includes('Select an item...'), dialog);
  assert.ok(boxes.length >= 2, dialog);
  assert.deepEqual(tickedBoxes(dialog), []);
  const enabled = await admin.attempt('is', 'enabled', confirmButton);
  assert.equal(enabled.stdout.trim(), 'false', 'the dialog waits for a file');
  await shot(admin, '16-import-reopens-empty.png');
  await clickMatching(
    admin,
    (line) => line.includes('button "Cancel"'),
    dialogs,
  );
  await waitUntil('the dialog to close', async () => {
    const shown = await admin.attempt('is', 'visible', confirmButton);
    return shown.stdout.trim() !== 'true';
  });
};

// The editor sees the status, runs nothing and follows a review link.
// The state line is read itself: the Flow's description beside it names
// the same rule.
export const editorFollowsReview = async ({
  editor,
  panel,
  runButton,
  shot,
}) => {
  const state = `${panel(publishAssetsFlowId)} p.state`;
  await waitUntil('the Administrators only state', async () => {
    const shown = await textOf(editor, state);
    return shown.trim() === 'Administrators only';
  });
  const enabled = await editor.attempt(
    'is',
    'enabled',
    runButton(publishAssetsFlowId),
  );
  assert.equal(enabled.stdout.trim(), 'false');
  await editor.command('wait', '[data-check="entry_needs_mapping"] a');
  await shot(editor, '12-editor-dashboard.png');
  await editor.click('[data-check="entry_needs_mapping"] a');
  await editor.command(
    'wait',
    '--url',
    '**/admin/content/moodle_course_entries?bookmark=*',
  );
  await editor.command('wait', '--load', 'networkidle');
  const page = await textOf(editor, 'body');
  assert.ok(!page.includes('Page Not Found'), 'the review link opens a page');
  assert.ok(page.includes('Needs mapping'), 'the review bookmark is open');
  await shot(editor, '13-editor-needs-mapping.png');
};

// No Moodle user's name or address, and no password, in the page text of
// the dashboard, in either browser's console and page errors, or in any
// request or answer body the browser exchanged since its login (the HAR
// recorded from then on, which must hold the status answers it showed).
export const checksPrivacy = async ({ admin, editor, state, t }) => {
  const secrets = [
    ...privateMarks,
    state.users.admin.password,
    state.users.editor.password,
  ];
  for (const session of [admin, editor]) {
    const entries = await stopRecording(session);
    const network = entries.map(entryText);
    assert.ok(
      network.some(
        (text) =>
          text.includes('/finki-hub-data-status') &&
          text.includes('"audience"'),
      ),
      `${session.name}: the recording holds the status answers`,
    );
    const logs = [
      await session.command('console'),
      await session.command('errors'),
      await textOf(session, 'body'),
    ].join('\n');
    const found = secrets.filter(
      (secret) =>
        logs.includes(secret) || network.some((text) => text.includes(secret)),
    );
    assert.deepEqual(found.length, 0, `${session.name} shows private text`);
    t.diagnostic(
      `${session.name}: ${entries.length} requests with their bodies and ${logs.split('\n').length} lines of page text and logs, no private text`,
    );
  }
};

export const cleansUp = async ({ s3, state, target }) => {
  await removeFlow(target, syntheticFlowId);
  await removeFlow(target, probeParentId);
  await removeFlow(target, probeChildId);
  const files = await get(target, '/files?fields=id&limit=-1');
  for (const { id } of files) {
    if (!state.fileIdsBefore?.has(id)) await remove(target, `/files/${id}`);
  }
  const keys = await listKeys(s3);
  for (const key of keys) {
    if (!state.keysBefore.has(key)) await deleteObject(s3, key);
  }
  await state.users?.remove();
  if (state.csvDirectory !== undefined) {
    await rm(state.csvDirectory, { force: true, recursive: true });
  }
};
