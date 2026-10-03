import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { declaredFilenames } from '../directus/extensions/directus-extension-data-operations/src/coordination/outcomes.js';
import { operationsDashboardId } from '../src/data-model/operations-dashboard.js';
import { ruleSeedingFlowId } from '../src/flows/add-enrollment-rules.js';
import { publishAssetsFlowId } from '../src/flows/publish-public-assets.js';
import { snapshotFlowId } from '../src/flows/snapshot-import.js';
import { runSetup } from '../src/setup.js';
import { assertMarkerPresent, targetFrom } from './isolated-target.mjs';
import {
  browserSession,
  browserUsers,
  clickMatching,
  closeBrowser,
  login,
  pickInDrawer,
  requireBrowser,
  startRecording,
  textOf,
  tickedBoxes,
  waitUntil,
} from './operations-browser-helpers.mjs';
import {
  addsPanel,
  checksPrivacy,
  cleansUp,
  followsReview,
  publishStep,
  reopensEmpty,
  seedRows,
  waitsForStatus,
} from './operations-browser-steps.mjs';
import {
  editsRelationNatively,
  keepsStateOnFailedImport,
} from './operations-browser-workflow.mjs';
import {
  bucketStatus,
  installProbe,
  listKeys,
  probeParentId,
  probeRuns,
  readOnlyBucket,
  trigger,
  verifyPublishLocation,
} from './publish-flow-helpers.mjs';
import {
  runsSince,
  settle,
  wallClock,
} from './relational/automatic-processing-helpers.mjs';
import {
  adminRequest,
  assertNoAccessResidue,
  pauseAutomaticProcessing,
  userCollections,
  withDataModel,
} from './relational/data-model-helpers.mjs';
import { count, get } from './relational/history-index-helpers.mjs';
import { s3TargetFrom } from './s3-target.js';

// `npm run test:operations` (second half): the Data operations dashboard
// in a real browser through the locally installed agent-browser CLI, on
// the synthetic fixture and its local S3 bucket only. The session sees
// Run wait (and say why) while the status cannot be read, seeds the
// rules of a new year, imports a generated snapshot (the file chosen in
// the Flow's own dialog) and finds the next Run's dialog empty, publishes,
// edits a relation in Studio's item form and publishes it, meets a failed
// publication and retries it, sees a partial one file by file, adds a
// panel for a new manual Flow without a rebuild, imports a malformed
// snapshot that leaves the active users and every object intact, and
// follows a review link from the Readiness panel.
// Everything is synthetic; the run removes what it created. Without
// agent-browser it fails, never skips.

const dashboardPath = `/admin/insights/${operationsDashboardId}`;
const snapshotRows = 10_000;
const snapshotTitle = 'synthetic-browser-snapshot';
const [, second, third] = declaredFilenames;
const nothingToResume = () => Promise.resolve();
const nothingToFill = () => Promise.resolve();

const confirmButton = '.confirm-run button';

const panel = (flowId) => `[data-flow="${flowId}"]`;
const runButton = (flowId) => `${panel(flowId)} .run button`;

const screenshotsDir = async () => {
  const named = process.env.OPERATIONS_BROWSER_SCREENSHOTS;
  if (named === undefined || named === '') {
    return mkdtemp(path.join(os.tmpdir(), 'operations-browser-'));
  }
  await mkdir(named, { recursive: true });
  return named;
};

// Opens the dashboard and waits until every panel answered.
const openDashboard = async (session, target) => {
  await session.command('open', new URL(dashboardPath, target.base).href);
  await session.command('wait', '--text', 'Calculations');
  await session.command('wait', '--load', 'networkidle');
};

// Whether the run dialog opened within a few seconds.
const dialogOpens = async (session) => {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    const shown = await session.attempt('is', 'visible', confirmButton);
    if (shown.stdout.trim() === 'true') return true;
    await sleep(250);
  }
  return false;
};

// Opens a panel's run dialog. The schedule may take the claim between
// the check and the click, which disables Run (correctly); the click is
// then repeated once Run is enabled again.
const openRunDialog = (session, flowId) =>
  waitUntil('the run dialog to open', async () => {
    await waitUntil('Run to be enabled', async () => {
      const enabled = await session.attempt('is', 'enabled', runButton(flowId));
      return enabled.stdout.trim() === 'true';
    });
    await session.click(runButton(flowId));
    return dialogOpens(session);
  });

// Runs a panel's Flow through its own dialog: `fill` acts inside the
// dialog, then the dialog's Run is pressed (`confirm`: click, or dblclick
// for a double click); answers the moment the run was confirmed.
const runFromPanel = async (
  session,
  flowId,
  { confirm = 'click', fill = nothingToFill } = {},
) => {
  await openRunDialog(session, flowId);
  await fill();
  const since = wallClock();
  if (confirm === 'dblclick') {
    await session.command('dblclick', confirmButton);
  } else {
    await session.click(confirmButton);
  }
  return since;
};

const finished = (session, flowId) => async () => {
  const text = await textOf(session, panel(flowId));
  return text.includes('Succeeded');
};

// Picks an item in the dialog's item picker by the text of its row.
const pickItem = (session, text) =>
  pickInDrawer(session, {
    picker: (line) => line.includes('"Select an item... expand_more"'),
    scope: '#dialog-outlet',
    text,
  });

const setsUp = async (context) => {
  const { directus, state, target } = context;
  await runSetup(directus);
  const rows = await seedRows(target, state, { snapshotRows, snapshotTitle });
  const users = await browserUsers(target);
  Object.assign(state, rows, { users });
  await settle(target);
};

const showsDashboard = async ({
  admin,
  cli,
  profiles,
  shot,
  state,
  target,
}) => {
  await login({
    ...state.users.admin,
    base: target.base,
    cli,
    profile: profiles[0],
    session: admin,
  });
  // The privacy check reads every request and answer from here on.
  await startRecording(admin);
  await openDashboard(admin, target);
  await shot(admin, '01-dashboard-overview.png');
  // Each panel links to its Flow's editable configuration.
  await admin.click(`${panel(publishAssetsFlowId)} .settings`);
  await admin.command(
    'wait',
    '--url',
    `**/admin/settings/flows/${publishAssetsFlowId}`,
  );
  await admin.command('wait', '--text', 'Publish / Public assets');
  const settings = await textOf(admin, 'body');
  assert.ok(!settings.includes('Page Not Found'), 'the Flow settings open');
  await openDashboard(admin, target);
};

const seedsRules = async ({ admin, shot, state, target }) => {
  await runFromPanel(admin, ruleSeedingFlowId, {
    fill: () => pickItem(admin, state.yearLabel),
  });
  await waitUntil(
    'the rule seeding answer',
    finished(admin, ruleSeedingFlowId),
  );
  assert.equal(
    await count(target, 'course_enrollment_rules'),
    state.courses.length,
  );
  await shot(admin, '02-add-enrollment-rules.png');
};

// The import runs once: the dialog's Run pressed twice in a row (a real
// double click) starts one run, and the panel's Run is disabled while it
// runs.
const importsOnce = async ({ admin, shot, target }) => {
  const since = await runFromPanel(admin, snapshotFlowId, {
    confirm: 'dblclick',
    fill: async () => {
      await pickItem(admin, snapshotTitle);
      await clickMatching(
        admin,
        (line) => line.includes('checkbox'),
        '#dialog-outlet',
      );
      // The ticked acknowledgement, as the next Run must not show it.
      const dialog = await admin.command(
        'snapshot',
        '-i',
        '-s',
        '#dialog-outlet',
      );
      assert.notDeepEqual(tickedBoxes(dialog), [], dialog);
    },
  });
  const busy = await admin.attempt('is', 'enabled', runButton(snapshotFlowId));
  assert.equal(busy.stdout.trim(), 'false', 'Run is disabled while it runs');
  // Every other panel follows the server's claim.
  await waitUntil(
    'the publish panel to wait for the claim',
    async () => {
      const other = await admin.attempt(
        'is',
        'enabled',
        runButton(publishAssetsFlowId),
      );
      return other.stdout.trim() === 'false';
    },
    20_000,
  );
  await shot(admin, '03-import-and-claims.png');
  await waitUntil(
    'the import answer',
    finished(admin, snapshotFlowId),
    600_000,
  );
  assert.equal(await runsSince(target, snapshotFlowId, since), 1);
  assert.equal(await count(target, 'moodle_users'), snapshotRows);
  await settle(target, { limitMs: 600_000 });
  await admin.command('wait', '--text', 'Needs mapping');
  await shot(admin, '04-import-settled.png');
};

// Every upload fails while the bucket is read-only: the panel shows the
// refusal and a retry, the status every file failed; the retry publishes.
const retriesFailure = async ({ admin, s3, shot, state, target }) => {
  await state.rename('Retry');
  await openDashboard(admin, target);
  const restore = await readOnlyBucket(s3);
  try {
    await runFromPanel(admin, publishAssetsFlowId);
    await waitUntil('the refusal', async () => {
      const text = await textOf(admin, panel(publishAssetsFlowId));
      return text.includes('PUBLICATION_FAILED');
    });
  } finally {
    await restore();
  }
  const report = await get(target, '/finki-hub-data-status');
  assert.equal(report.publication.state, 'failed');
  assert.ok(
    report.publication.files.every(({ outcome }) => outcome === 'failed'),
  );
  await admin.command('wait', '--text', 'Failed');
  await shot(admin, '06-publish-failed-retry.png');
  await admin.click(`${panel(publishAssetsFlowId)} .retry button`);
  await admin.command('wait', confirmButton);
  await admin.click(confirmButton);
  await waitUntil(
    'the retried publication',
    finished(admin, publishAssetsFlowId),
    300_000,
  );
  const retried = await get(target, '/finki-hub-data-status');
  assert.equal(retried.publication.state, 'completed');
  // The status panels of the page follow the run without a reload.
  await waitUntil('the status panel to show the retry', async () => {
    const shown = await textOf(admin, `[data-file="${second}"]`);
    return shown.includes('Uploaded');
  });
  await shot(admin, '07-publish-retried.png');
};

// The probe copy of the publish Flow waits before the second and third
// file; the bucket is read-only only for the second upload.
const showsPartial = async ({ admin, s3, shot, state, target }) => {
  await state.rename('Partial');
  await installProbe(target, [second, third], 5_000);
  const since = wallClock();
  const running = trigger(target, probeParentId);
  let restore = nothingToResume;
  try {
    await probeRuns(target, since, 1);
    restore = await readOnlyBucket(s3);
    await probeRuns(target, since, 2);
  } finally {
    await restore();
  }
  const run = await running;
  assert.equal(run.status, 502, JSON.stringify(run.body));
  const report = await get(target, '/finki-hub-data-status');
  assert.equal(report.publication.state, 'partial');
  assert.deepEqual(
    report.publication.files.map(({ filename, outcome }) => [
      filename,
      outcome,
    ]),
    declaredFilenames.map((filename) => [
      filename,
      filename === second ? 'failed' : 'uploaded',
    ]),
  );
  await openDashboard(admin, target);
  await admin.command('wait', '--text', 'Partial');
  const shown = await textOf(admin, `[data-file="${second}"]`);
  assert.ok(shown.includes('PUBLISH_UPLOAD_FAILED'), shown);
  await shot(admin, '08-publish-partial.png');
};

// The session follows a review link, then comes back to the
// dashboard, whose page text the privacy check reads.
const followsReviewLink = async ({ admin, shot, target }) => {
  await openDashboard(admin, target);
  await followsReview({ admin, shot });
  await openDashboard(admin, target);
};

// Closes the browser and removes the run's rows; answers the resume of
// the schedule, which stays paused for the model teardown.
const finishes = async (context) => {
  const { admin, cli, profiles, s3, state, t, target } = context;
  try {
    try {
      const closed = await closeBrowser(cli, [admin], profiles);
      t.diagnostic(closed.join('; '));
    } finally {
      await cleansUp({ s3, state, target });
    }
  } finally {
    const resume = await pauseAutomaticProcessing(target);
    context.resumes.push(resume);
  }
};

const steps = [
  ['sets up the project, the synthetic rows and users', setsUp],
  ['shows the dashboard', showsDashboard],
  [
    'lets Run wait and say why while the status cannot be read, then follow it again',
    waitsForStatus,
  ],
  ['adds the rules of a new academic year from its panel', seedsRules],
  ['imports the generated snapshot chosen in the dialog, once', importsOnce],
  [
    'opens the next Run of the import empty, with no file and no acknowledgement',
    reopensEmpty,
  ],
  ['publishes to the local S3 bucket from its panel', publishStep],
  [
    "edits a relation in Studio's item form and publishes it from the dashboard",
    editsRelationNatively,
  ],
  ['offers a precise retry after a failed publication', retriesFailure],
  [
    'shows one outcome per declared file of a partial publication',
    showsPartial,
  ],
  [
    'adds a Run operation panel for a new manual Flow without a rebuild',
    addsPanel,
  ],
  [
    'keeps the active snapshot and every published object when an import from the dashboard fails',
    keepsStateOnFailedImport,
  ],
  [
    'follows a review link from the Readiness panel to its records',
    followsReviewLink,
  ],
  [
    'keeps private payloads out of the page status and the browser logs',
    checksPrivacy,
  ],
];

test('operates the data from the Data operations dashboard in a real browser', async (t) => {
  const cli = await requireBrowser();
  const target = targetFrom(process.env);
  const s3 = s3TargetFrom(process.env);
  await verifyPublishLocation(target, s3);
  assert.equal(await bucketStatus(s3), 200, 'the synthetic bucket exists');
  const keysBefore = new Set(await listKeys(s3));
  assert.deepEqual(
    declaredFilenames.filter((key) => keysBefore.has(key)),
    [],
    'no declared object is in the bucket before the run',
  );
  const shots = await screenshotsDir();
  t.diagnostic(`agent-browser ${cli.version}; screenshots in ${shots}`);
  const admin = browserSession(cli, `operations-admin-${process.pid}`);
  const context = {
    admin,
    cli,
    confirmButton,
    directus: adminRequest(target),
    openDashboard,
    openRunDialog,
    panel,
    pickItem,
    profiles: [`${admin.name}-auth`],
    resumes: [],
    runButton,
    runFromPanel,
    s3,
    // A short pause lets Studio finish a dialog or drawer transition.
    shot: async (session, name) => {
      await session.command('wait', '500');
      await session.command('screenshot', path.join(shots, name));
    },
    state: { files: [], keysBefore },
    t,
    target,
  };

  await withDataModel(
    target,
    async () => {
      try {
        for (const [name, step] of steps) {
          await t.test(name, () => step(context));
        }
      } finally {
        await t.test(
          'closes the browser and removes what the run created',
          () => finishes(context),
        );
      }
    },
    { automatic: true },
  );
  for (const resume of context.resumes) await resume();
  await assertNoAccessResidue(target);
  await assertMarkerPresent(target);
  assert.deepEqual(await userCollections(target), [target.markerCollection]);
});
