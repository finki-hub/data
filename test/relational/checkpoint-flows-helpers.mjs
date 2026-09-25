import assert from 'node:assert/strict';

import { derivedDataFlowId } from '../../src/derived-data-flow.js';
import { publicAssetsFlowId } from '../../src/public-assets-flow.js';
import { deleteObject, listKeys } from '../publish-flow-helpers.mjs';
import { publishPreconditions } from '../publish-workflow-helpers.mjs';
import { assertNoAccessResidue } from './data-model-helpers.mjs';
import { get, patch, remove } from './history-index-helpers.mjs';
import { callAs, codeOf, withAccessUsers } from './operations-helpers.mjs';

// The two checkpoint Flows the one-time workbook import installs, on the
// fixture after `npm run import`: a synthetic user holding only the Data
// editor policy (through a role, example.com address) passes the trigger
// endpoint, which checks read access to the Flow's collection only, and is
// refused by each Flow's own Administrator? gate with 403 before any
// write; the administrator still runs both. The derived values are made
// stale first, so a rebuild that ran would show. Nothing but statuses,
// codes and counts is reported.

const checkpointFiles = [
  'courses.json',
  'rooms.json',
  'staff.json',
  'students.json',
];
const stale = 'Synthetic stale value';

const byText = (left, right) => left.localeCompare(right, 'en');

export const checkpointFlows = [
  {
    id: derivedDataFlowId,
    message: 'Only administrators may rebuild the derived data.',
    name: 'Rebuild derived data',
  },
  {
    id: publicAssetsFlowId,
    message: 'Only administrators may publish the public files.',
    name: 'Publish public assets',
  },
];

// A run of a checkpoint Flow from the courses page, as Studio posts it.
const trigger = (target, token, id) =>
  callAs(target, token, {
    body: { collection: 'courses' },
    method: 'POST',
    path: `/flows/trigger/${id}`,
  });

// The first course's professors and the first council member's copied
// name: both are values every rebuild rewrites.
const derivedValues = async (target) => {
  const [course] = await get(
    target,
    '/items/courses?fields=id,professors&sort=id&limit=1',
  );
  const [member] = await get(
    target,
    '/items/student_council?fields=id,name&sort=id&limit=1',
  );
  return { course, member };
};

// The files Directus holds in the publish location (each upload is one).
const publishFiles = async (target) => {
  const files = await get(
    target,
    '/files?fields=id&limit=-1&filter[storage][_eq]=publish',
  );
  return files.map(({ id }) => id);
};

// The keys of the synthetic bucket, sorted.
const sortedKeys = async (s3) => {
  const keys = await listKeys(s3);
  return keys.toSorted(byText);
};

// Removes what a checkpoint Publish run wrote: every file in the publish
// location (none was there before the run) and, with the S3 target, every
// object the bucket did not hold before (`keysBefore`, a Set).
const removePublished = async ({ keysBefore, s3, target }) => {
  const files = await publishFiles(target);
  for (const id of files) await remove(target, `/files/${id}`);
  if (s3 === null) return;
  const keys = await listKeys(s3);
  for (const key of keys) {
    if (!keysBefore.has(key)) await deleteObject(s3, key);
  }
};

// The Flows are installed, active and gated, as the import left them.
const assertInstalledGated = async (target) => {
  for (const { id, name } of checkpointFlows) {
    const flow = await get(
      target,
      `/flows/${id}?fields=name,status,trigger,options,operation.key`,
    );
    assert.equal(flow.name, name);
    assert.equal(flow.status, 'active');
    assert.equal(flow.trigger, 'manual');
    assert.equal(flow.options.error_on_reject, true, name);
    assert.equal(flow.operation.key, 'admin_only', name);
  }
};

// The editor's triggers answer the gate's 403 (Rebuild first) and change
// nothing: the Flows stay installed and active, the stale derived values
// stay, no file reaches the publish location and, with the S3 target, no
// object reaches the bucket. Whatever a run that was not refused wrote
// there is removed before the failure is reported, so a regressed gate
// leaves no file or object on the fixture. The administrator's rebuild
// then restores the derived values.
export const refusesEditor = async ({ s3, t, target }) => {
  const rebuilt = await derivedValues(target);
  await patch(target, `/items/courses/${rebuilt.course.id}`, {
    professors: stale,
  });
  await patch(target, `/items/student_council/${rebuilt.member.id}`, {
    name: stale,
  });
  const staleValues = await derivedValues(target);
  assert.deepEqual(
    [staleValues.course.professors, staleValues.member.name],
    [stale, stale],
  );
  const keysBefore = s3 === null ? null : new Set(await listKeys(s3));
  assert.deepEqual(await publishFiles(target), []);
  try {
    await withAccessUsers(target, async ({ editor }) => {
      for (const { id, message, name } of checkpointFlows) {
        const run = await trigger(target, editor, id);
        assert.equal(run.status, 403, `${name}: ${JSON.stringify(run.body)}`);
        assert.equal(codeOf(run), 'FORBIDDEN');
        // The gate's own message: the trigger endpoint let the editor
        // through.
        assert.equal(run.body.errors[0].message, message);
      }
    });
    await assertNoAccessResidue(target);
    await assertInstalledGated(target);
    assert.deepEqual(await derivedValues(target), staleValues);
    assert.deepEqual(await publishFiles(target), []);
    if (keysBefore !== null) {
      assert.deepEqual(await sortedKeys(s3), [...keysBefore].toSorted(byText));
    }
  } finally {
    await removePublished({ keysBefore, s3, target });
  }
  const rebuild = await trigger(target, target.token, derivedDataFlowId);
  assert.equal(rebuild.status, 200, JSON.stringify(rebuild.body));
  assert.ok(rebuild.body.courses > 0 && rebuild.body.studentCouncilMembers > 0);
  assert.deepEqual(await derivedValues(target), rebuilt);
  t.diagnostic(
    `a Data editor: ${String(checkpointFlows.length)} checkpoint Flows refused it (403); bucket ${keysBefore === null ? 'not checked (no S3 target)' : 'unchanged'}; the administrator's rebuild answered 200`,
  );
};

// The administrator's run of the checkpoint Publish writes the four files
// the checkpoint knew into the synthetic bucket (the publish location is
// checked first); they are removed at once.
export const publishesAsAdministrator = async ({ s3, t, target }) => {
  const { keysBefore } = await publishPreconditions(target, s3);
  try {
    const run = await trigger(target, target.token, publicAssetsFlowId);
    assert.equal(run.status, 200, JSON.stringify(run.body).slice(0, 1_500));
    const keys = await sortedKeys(s3);
    const added = keys.filter((key) => !keysBefore.has(key));
    assert.deepEqual(added, checkpointFiles);
    t.diagnostic(`the administrator published ${String(added.length)} files`);
  } finally {
    await removePublished({ keysBefore, s3, target });
  }
  assert.deepEqual(await sortedKeys(s3), [...keysBefore].toSorted(byText));
  assert.deepEqual(await publishFiles(target), []);
};
