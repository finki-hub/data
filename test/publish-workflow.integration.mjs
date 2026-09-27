import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { declarations } from './fixtures/stress-fixture.js';
import { assertMarkerPresent, isolatedTargets } from './isolated-target.mjs';
import {
  extendsGeneration,
  extendsYear,
} from './publish-workflow-extensions.mjs';
import {
  blocksUnresolvedLink,
  failsInvalidPattern,
  refusesMalformedImport,
  refusesWithoutPermission,
  survivesStorageFailure,
} from './publish-workflow-failures.mjs';
import {
  publishPreconditions,
  removeRunFiles,
  snapshotFiles,
} from './publish-workflow-helpers.mjs';
import {
  deletesParentsAtInstall,
  keepsConcurrentEdits,
  recoversAfterRestart,
  retriesInstallAfterDeadlock,
} from './publish-workflow-races.mjs';
import {
  countsAutomatically,
  importsUnchangedCsv,
  publishesManually,
  publishesRelationChange,
  seeds,
  setsUp,
} from './publish-workflow-steps.mjs';
import {
  adminRequest,
  pauseAutomaticProcessing,
  userCollections,
  withDataModel,
} from './relational/data-model-helpers.mjs';

// `npm run test:s3` (second suite): the complete synthetic workflow on the
// isolated fixture and its local S3 bucket, with real HTTP and native Flow
// execution throughout. The fixture is generated from the declarations
// (test/fixtures/stress-*.ts) at a bounded size and written through the
// REST API; the unchanged generated CSV goes through staging and
// promotion; the native schedule counts; readiness and the manual publish
// write every declared file. Then each failure (malformed import,
// unresolved link, invalid pattern, missing permission, restart,
// concurrent edits and deletes, a deadlock at the install, S3 failure)
// leaves the active snapshot and every published object intact, and the
// extension scenarios add a year and a generation as rows. The run
// removes what it created.

const size = { courses: 12, labels: 300, referenceRows: 20, users: 1_500 };
const nothingToResume = () => Promise.resolve();
const requirements = { containers: ['directus', 'database'], s3: 'required' };
const notPublishedPattern = /does not publish/u;
const otherDirectusPattern = /DIRECTUS_S3_TEST_DIRECTUS_CONTAINER/u;
const otherDatabasePattern = /DB_HOST/u;

const steps = [
  ['sets up the project', setsUp],
  ['writes the generated reference rows through the REST API', seeds],
  [
    'imports the unchanged generated CSV through staging and promotion',
    importsUnchangedCsv,
  ],
  [
    'indexes and counts on the native schedule exactly as the oracle',
    countsAutomatically,
  ],
  [
    'passes readiness and publishes every declared file manually',
    publishesManually,
  ],
  [
    'publishes a changed relation into courses.json and nothing else',
    publishesRelationChange,
  ],
  [
    'refuses a malformed import, keeps the snapshot and the objects, and recovers with the unchanged CSV',
    refusesMalformedImport,
  ],
  [
    'blocks publication on an unresolved assignment link before any upload',
    blocksUnresolvedLink,
  ],
  [
    'fails the counts on an invalid pattern without installing, blocks publication, then recovers',
    failsInvalidPattern,
  ],
  [
    'refuses every operation to callers without the permission',
    refusesWithoutPermission,
  ],
  [
    'recovers a count run across a Directus restart that caught it holding its claim',
    recoversAfterRestart,
  ],
  [
    'counts an edit that committed while a run held its claim on the next run',
    keepsConcurrentEdits,
  ],
  [
    'keeps counts consistent when parents are deleted while a run installs (follow-up 11)',
    deletesParentsAtInstall,
  ],
  [
    'completes an install that lost a deadlock in place after one retry',
    retriesInstallAfterDeadlock,
  ],
  [
    'records a storage failure per file, keeps the objects and converges on a retry',
    survivesStorageFailure,
  ],
  [
    'adds a new academic year from its rules to one key per course only once published',
    extendsYear,
  ],
  [
    'adds a test-only generation with two programs only once published, exactly its declared keys',
    extendsGeneration,
  ],
];

// Containers that do not belong to the target are refused before any of
// them is touched: another container as the Directus one (it does not
// publish the target's port), a Directus container other than the one the
// S3 target names, and another container as the database (not the one
// DB_HOST names). Docker is only read.
const refusesForeignContainers = async (environment, { containers, s3 }) => {
  const refusals = [
    [
      { DIRECTUS_COORDINATION_RESTART_CONTAINER: s3.container },
      notPublishedPattern,
    ],
    [
      { DIRECTUS_S3_TEST_DIRECTUS_CONTAINER: containers.database },
      otherDirectusPattern,
    ],
    [
      { DIRECTUS_AUTOMATIC_DATABASE_CONTAINER: s3.container },
      otherDatabasePattern,
    ],
  ];
  for (const [override, pattern] of refusals) {
    await assert.rejects(
      isolatedTargets({ ...environment, ...override }, requirements),
      pattern,
    );
  }
};

test('runs the complete synthetic editing, import, derivation and publish workflow', async (t) => {
  const { containers, s3, target } = await isolatedTargets(
    process.env,
    requirements,
  );
  await t.test('refuses containers that do not belong to the target', () =>
    refusesForeignContainers(process.env, { containers, s3 }),
  );
  const { keysBefore, location } = await publishPreconditions(target, s3);
  t.diagnostic(`publish location ${JSON.stringify(location)}`);
  const state = {
    dir: await mkdtemp(path.join(os.tmpdir(), 'publish-workflow-')),
    files: [],
    filesBefore: new Set(await snapshotFiles(target)),
    keysBefore,
  };
  const context = {
    containers,
    declarations,
    directus: adminRequest(target),
    s3,
    size,
    state,
    t,
    target,
  };
  let resume = nothingToResume;
  await withDataModel(
    target,
    async () => {
      try {
        for (const [name, step] of steps) {
          await t.test(name, () => step(context));
        }
      } finally {
        await t.test('removes the objects and files it created', async () => {
          try {
            await removeRunFiles(context);
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
