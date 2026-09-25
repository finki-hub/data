import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { declarations } from './fixtures/stress-fixture.js';
import { assertMarkerPresent, isolatedTargets } from './isolated-target.mjs';
import { bucketStatus, listKeys, readObject } from './publish-flow-helpers.mjs';
import {
  adminRequest,
  destroyDataModel,
  userCollections,
} from './relational/data-model-helpers.mjs';
import { get } from './relational/history-index-helpers.mjs';
import {
  createBackup,
  damagedCopy,
  removeBackup,
  restoreBackup,
} from './restore-backup.mjs';
import { showsRestoredStudio } from './restore-browser.mjs';
import {
  probeUpload,
  provideDatabase,
  removeRestoreResources,
  resourceState,
  restoreObjectCount,
  restoreResources,
  restoreTableCount,
  uploadsEntries,
  writeProbeUpload,
  writeProbeView,
} from './restore-docker.mjs';
import { assertPrivateRoot, runDirectories } from './restore-private-root.js';
import {
  buildsProject,
  customizesProject,
  leavesEditPending,
  recordsState,
  revertsFixture,
} from './restore-project.mjs';
import {
  removeOverride,
  sourceOf,
  switchBack,
  switchToRestore,
} from './restore-switch.mjs';
import { restoreTargetFrom } from './restore-target.js';
import {
  createBucket,
  keepsCustomizations,
  logsIn,
  processesPendingEdit,
  publishesUnchanged,
  removeBucket,
  showsBranding,
} from './restore-verify.mjs';

// `npm run test:restore`: a private backup of the relational model and an
// isolated restore of it, on the synthetic fixture only. The source
// project is built through setup, a generated workbook import and a
// generated snapshot import, then customized (the publish Flow edited in
// Studio, a bookmark, the branding, a password user, source edits) with
// one source edit still pending. The backup is a custom-format pg_dump,
// an uploads archive, checksums and a manifest in a private directory
// outside every Git repository, which must hold no directory of an
// earlier run. A truncated or altered dump, a restore target that is not
// disposable and one whose database or uploads volume is not empty are
// refused before any write. The set is restored into a fresh PostgreSQL
// container and uploads volume of an explicitly disposable name, and the
// source's one Directus container serves it (restore-switch.mjs explains
// why the licence identity stays in that container): the restored project
// signs in, shows its branding, keeps its customizations, counts the
// pending edit on the next tick and publishes every declared file into a
// fresh bucket equal to the export recorded before the backup. The source
// is then served again from its own database, every restore resource, the
// bucket and the backup are removed and the fixture returns to
// marker-only. The run must not be interrupted; the README (Backup and
// restore) says how to recover a fixture an interrupted run left.

const repository = fileURLToPath(new URL('..', import.meta.url));
const requirements = { containers: ['directus', 'database'], s3: 'required' };
const size = { users: 400 };
const damagedPattern = /refused before any write: directus\.dump/u;
const foreignPattern = /is not a disposable resource of .+; refused/u;
const nonEmptyPattern = /not an empty restore target; refused/u;
const nonEmptyUploadsPattern = /_uploads_data is not empty; refused/u;
const namePattern = /DIRECTUS_RESTORE_TEST_NAME must be finki_restore_/u;
const bucketPattern = /DIRECTUS_RESTORE_TEST_BUCKET must be/u;

const absentResources = async (restore) => {
  for (const resource of restoreResources(restore)) {
    const state = await resourceState(resource, restore);
    assert.equal(state.exists, false, `${resource.name} was not created`);
  }
};

const backsUp = async (context) => {
  const { containers, restore, source, state, t } = context;
  state.backup = await createBackup({
    binding: source.binding,
    containers,
    restore,
  });
  const sizes = state.backup.manifest.artifacts.map(
    ({ bytes, kind }) => `${kind} ${String(bytes)} B`,
  );
  t.diagnostic(`backup set: ${sizes.join(', ')}, checksums and manifest`);
};

const refusesDamagedBackups = async ({ restore, state }) => {
  for (const damage of ['truncated', 'altered']) {
    const copy = await damagedCopy(restore, state.backup, damage);
    try {
      await assert.rejects(
        restoreBackup(restore, copy, state.restoreOptions),
        damagedPattern,
      );
      await absentResources(restore);
    } finally {
      await removeBackup(restore, copy);
    }
  }
};

const refusesForeignTarget = async ({
  containers,
  restore,
  s3,
  source,
  state,
}) => {
  const foreign = {
    ...restore,
    database: containers.database,
    uploadsVolume: source.uploadsVolume,
  };
  await assert.rejects(
    restoreBackup(foreign, state.backup, state.restoreOptions),
    foreignPattern,
  );
  const context = { publishBucket: s3.bucket, repository };
  assert.throws(
    () =>
      restoreTargetFrom(
        { ...process.env, DIRECTUS_RESTORE_TEST_NAME: source.binding.project },
        context,
      ),
    namePattern,
  );
  assert.throws(
    () =>
      restoreTargetFrom(
        { ...process.env, DIRECTUS_RESTORE_TEST_BUCKET: s3.bucket },
        context,
      ),
    bucketPattern,
  );
  await absentResources(restore);
};

// Two disposable targets, each refused before anything is restored: one
// whose database holds a schema object that is not a table (a view), one
// whose uploads volume holds a file.
const refusesNonEmptyTarget = async ({ restore, state }) => {
  const { image } = state.restoreOptions;
  await provideDatabase(restore, state.restoreOptions);
  await writeProbeView(restore);
  assert.equal(await restoreTableCount(restore), 0, 'the probe is no table');
  const objects = await restoreObjectCount(restore);
  await assert.rejects(
    restoreBackup(restore, state.backup, state.restoreOptions),
    nonEmptyPattern,
  );
  assert.equal(await restoreObjectCount(restore), objects, 'nothing restored');
  assert.deepEqual(await removeRestoreResources(restore), []);
  await absentResources(restore);
  await provideDatabase(restore, state.restoreOptions);
  await writeProbeUpload(restore, image);
  await assert.rejects(
    restoreBackup(restore, state.backup, state.restoreOptions),
    nonEmptyUploadsPattern,
  );
  assert.equal(await restoreObjectCount(restore), 0, 'nothing restored');
  assert.deepEqual(await uploadsEntries(restore, image), [probeUpload]);
  assert.deepEqual(await removeRestoreResources(restore), []);
  await absentResources(restore);
};

const restores = async ({ restore, s3, state, t }) => {
  await restoreBackup(restore, state.backup, state.restoreOptions);
  const tables = await restoreTableCount(restore);
  await createBucket(s3, restore.bucket);
  t.diagnostic(`restored ${String(tables)} tables and the uploads archive`);
};

const sourceSteps = [
  [
    'builds the source project through setup, a generated workbook import and a generated snapshot import',
    buildsProject,
  ],
  [
    'customizes it: the publish Flow edited in Studio, a bookmark, the branding, a password user and source edits',
    customizesProject,
  ],
  ['records the export and the state a restore must reproduce', recordsState],
  ['leaves one source edit pending for the next tick', leavesEditPending],
  [
    'backs up the database and the uploads into a private set with checksums',
    backsUp,
  ],
  [
    'refuses a truncated or altered dump before any write',
    refusesDamagedBackups,
  ],
  ['refuses a restore target that is not disposable', refusesForeignTarget],
  [
    'refuses a restore target whose database or uploads volume is not empty',
    refusesNonEmptyTarget,
  ],
  [
    'restores the set into a fresh disposable database and uploads volume',
    restores,
  ],
  [
    "serves the restored project from the source's one Directus container",
    switchToRestore,
  ],
  ['signs in with a password set before the backup', logsIn],
  ['shows the branding and every uploaded file byte for byte', showsBranding],
  [
    'keeps the Studio edits of the publish Flow and the bookmark',
    keepsCustomizations,
  ],
  [
    'keeps the pending source edit and counts it on the next tick',
    processesPendingEdit,
  ],
  [
    'publishes every declared file into a fresh bucket, equal to the recorded export',
    publishesUnchanged,
  ],
];

// Screenshots of the restored project in a real browser, on request.
const browserSteps = process.env.DIRECTUS_RESTORE_SCREENSHOTS
  ? [
      [
        'shows the branded login, the edited Flow and the bookmark in a browser',
        showsRestoredStudio,
      ],
    ]
  : [];

// Runs the steps in order and stops at the first that fails: a later step
// never runs against a project an earlier one did not reach.
const runSteps = async (t, steps, context) => {
  for (const [name, step] of steps) {
    let passed = false;
    await t.test(name, async () => {
      await step(context);
      passed = true;
    });
    if (!passed) return;
  }
};

// Everything the run created outside the fixture's own database: the
// restore resources, the bucket, the override and the backup sets. Each
// removal is attempted even when an earlier one failed (a Directus
// container left on the restore target keeps its uploads volume in use);
// the step then fails once, naming everything that was left. Afterwards
// the backup root holds no directory of the run but a kept backup set.
const removesRestore = async ({ restore, s3, state, t }) => {
  const left = [];
  const removing = async (what, remove) => {
    try {
      return await remove();
    } catch (error) {
      left.push(`${what} (${error.message})`);
      return null;
    }
  };
  const kept = await removing('the restore resources', () =>
    removeRestoreResources(restore),
  );
  if (kept?.length) {
    left.push(
      `resources of these names the run did not own: ${kept.join(', ')}`,
    );
  }
  const objects = await removing(`the bucket ${restore.bucket}`, () =>
    removeBucket(s3, restore.bucket),
  );
  if (state.override) {
    await removing('the override', () =>
      removeOverride(restore, state.override),
    );
  }
  const keepSet = Boolean(state.backup && restore.keepBackup);
  if (state.backup && !keepSet) {
    await removing('the backup set', () => removeBackup(restore, state.backup));
  }
  await removing('a restore resource', () => absentResources(restore));
  await removing('a directory of the run under the backup root', async () => {
    assert.deepEqual(
      await runDirectories(restore.backupRoot),
      keepSet ? [path.basename(state.backup.directory)] : [],
    );
  });
  if (left.length > 0) {
    assert.fail(`The cleanup left: ${left.join('; ')}`);
  }
  t.diagnostic(
    `removed the restore resources, the bucket with ${String(objects)} objects${keepSet ? '; the backup set was kept on request' : ' and the backup set'}`,
  );
};

const fixtureObjects = async (s3) => {
  const keys = await listKeys(s3);
  return Object.fromEntries(
    await Promise.all(
      keys.map(async (key) => [key, await readObject(s3, key)]),
    ),
  );
};

const idsOf = async (target, query) => {
  const rows = await get(target, query);
  return new Set(rows.map(({ id }) => id));
};

test('rehearses a private backup and an isolated restore of the relational model', async (t) => {
  const { containers, s3, target } = await isolatedTargets(
    process.env,
    requirements,
  );
  const restore = restoreTargetFrom(process.env, {
    publishBucket: s3.bucket,
    repository,
  });
  await assertPrivateRoot(restore.backupRoot);
  assert.deepEqual(
    await runDirectories(restore.backupRoot),
    [],
    'DIRECTUS_RESTORE_BACKUP_DIR still holds a directory of an earlier run (a kept or partial backup set, or an override); move or remove it first; refused before any change',
  );
  const source = await sourceOf({ containers, target });
  await absentResources(restore);
  assert.equal(
    await bucketStatus({ ...s3, bucket: restore.bucket }),
    404,
    `${restore.bucket} must not exist yet`,
  );
  assert.deepEqual(await userCollections(target), [target.markerCollection]);
  const objectsBefore = await fixtureObjects(s3);
  const state = {
    databasePassword: randomBytes(18).toString('hex'),
    dir: await mkdtemp(path.join(os.tmpdir(), 'restore-rehearsal-')),
    files: [],
    filesBefore: await idsOf(target, '/files?fields=id&limit=-1'),
    flowsBefore: await idsOf(target, '/flows?fields=id&limit=-1'),
  };
  state.restoreOptions = {
    image: source.databaseImage,
    network: source.network,
    owner: source.owner,
    password: state.databasePassword,
  };
  const context = {
    containers,
    declarations,
    directus: adminRequest(target),
    restore,
    restoreS3: { ...s3, bucket: restore.bucket },
    s3,
    size,
    source,
    state,
    t,
    target,
  };
  try {
    await runSteps(t, [...sourceSteps, ...browserSteps], context);
  } finally {
    if (state.switched) {
      await t.test(
        'serves the source project again from its own database',
        () => switchBack(context),
      );
    }
    await t.test(
      'removes the restore resources, the bucket and the backup',
      () => removesRestore(context),
    );
    if (!state.switched || state.backOnSource) {
      await t.test('returns the fixture to marker-only', async () => {
        try {
          await revertsFixture(context);
          await destroyDataModel(target);
        } finally {
          await state.resumeSchedule?.();
        }
      });
    }
    await rm(state.dir, { force: true, recursive: true });
  }
  await assertMarkerPresent(target);
  assert.deepEqual(await userCollections(target), [target.markerCollection]);
  assert.deepEqual(
    await fixtureObjects(s3),
    objectsBefore,
    'no object of the source bucket was written',
  );
});
