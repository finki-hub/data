import assert from 'node:assert/strict';

import { declaredFilenames } from '../directus/extensions/directus-extension-data-operations/src/coordination/outcomes.js';
import { assignmentRoles } from '../directus/extensions/directus-extension-data-operations/src/exports/course-values.js';
import { exportDefinitions } from '../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { ruleSeedingFlowId } from '../src/flows/add-enrollment-rules.js';
import { markPendingFlowId } from '../src/flows/mark-pending.js';
import { prepareAssetsFlowId } from '../src/flows/prepare-public-assets.js';
import { publishAssetsFlowId } from '../src/flows/publish-public-assets.js';
import { snapshotFlowId } from '../src/flows/snapshot-import.js';
import { validateReadinessFlowId } from '../src/flows/validate-readiness.js';
import {
  countDifferences,
  createRows,
  installedCounts,
} from './fixture-seed.mjs';
import { readOnlyBucket, trigger } from './publish-flow-helpers.mjs';
import {
  assertCounts,
  assertIntact,
  codeOf,
  digestsOf,
  objectsOf,
  publishes,
  refusedPublication,
  ruleOf,
  setPattern,
  settlesCounted,
  snapshotState,
  uploadSnapshot,
} from './publish-workflow-helpers.mjs';
import {
  settle,
  waitForStatus,
  withOperationsReader,
} from './relational/automatic-processing-helpers.mjs';
import {
  get,
  patch,
  remove,
  status,
} from './relational/history-index-helpers.mjs';
import {
  callAs,
  runFlow,
  withAccessUsers,
} from './relational/operations-helpers.mjs';
import { runImport } from './relational/snapshot-import-helpers.mjs';

// The failure scenarios of the complete workflow suite. Each one fails in
// a real way on the fixture (a malformed CSV, an unresolved link, a
// pattern that does not compile, a caller without the permission, a
// read-only bucket) and checks that the active snapshot and every
// published object stayed as they were, then recovers through the
// supported path. The races (a restart, edits and deletes during a run)
// are in publish-workflow-races.mjs.

const [professor] = assignmentRoles;
const operationFlows = [
  snapshotFlowId,
  publishAssetsFlowId,
  ruleSeedingFlowId,
  markPendingFlowId,
  prepareAssetsFlowId,
  validateReadinessFlowId,
];
const unterminated = '1,"Unterminated synthetic late row\n';
const roomsFile =
  exportDefinitions.find(({ rows }) => rows.collection === 'rooms')?.filename ??
  '';

const notClaimed = 'PUBLICATION_NOT_CLAIMED';
const notPrepared = 'PUBLICATION_NOT_PREPARED';

// Marks publication pending through "Data / Mark pending", so that a
// refusal is readiness's and not "nothing pending".
const markPublicationPending = async ({ target }) => {
  const marked = await runFlow(target, target.token, {
    id: markPendingFlowId,
    values: { domains: ['publication'] },
  });
  assert.equal(marked.status, 200, JSON.stringify(marked.body));
};

// A late malformed row: the import is refused after the whole file was
// read and the active users and every object stay. Nothing is pending,
// so a publish claims nothing; once publication is marked pending,
// readiness blocks it until the unchanged CSV is imported again.
export const refusesMalformedImport = async (context) => {
  const { state, t, target } = context;
  const last = state.snapshotRows.rows.length - 1;
  const file = await uploadSnapshot(context, {
    name: 'workflow-malformed',
    raw: new Map([[last, unterminated]]),
  });
  let run;
  try {
    run = await runImport(target, { confirm_replace: true, file });
    assert.equal(run.status, 400, JSON.stringify(run.body).slice(0, 1_500));
    assert.equal(codeOf(run.body), 'SNAPSHOT_INVALID_CSV');
    await assertIntact(context, 'malformed import');
    await refusedPublication(context, {
      code: notClaimed,
      label: 'nothing to publish after a failed import',
      reason: 'nothing_pending',
    });
    await markPublicationPending(context);
    await refusedPublication(context, {
      code: notPrepared,
      label: 'publication after a failed import',
      reason: 'snapshot_import_failed',
    });
  } finally {
    const again = await runImport(target, {
      confirm_replace: true,
      file: state.snapshotFile,
    });
    assert.equal(again.status, 200, JSON.stringify(again.body).slice(0, 1_500));
    assert.equal(again.body.fingerprint, state.snapshot.active.fingerprint);
    Object.assign(state, { snapshot: await snapshotState(target) });
  }
  await settlesCounted(context, 'after the unchanged CSV again');
  const published = await publishes(context);
  t.diagnostic(
    `malformed import ${run.status} ${codeOf(run.body)}; publication refused; unchanged CSV imported again and published at revision ${published.revision}`,
  );
};

// A published assignment row with neither staff nor label: readiness
// blocks courses.json before any upload; removing the row lets it
// publish.
export const blocksUnresolvedLink = async (context) => {
  const { state, target } = context;
  const course = state.seeded.courses[1];
  const [row] = await createRows(target, 'teaching_assignments', [
    { course: course.id, course_name: course.name, role: professor, sort: 9 },
  ]);
  try {
    await settle(target);
    await refusedPublication(context, {
      code: notPrepared,
      label: 'unresolved link',
      reason: 'assignment_unresolved',
    });
  } finally {
    await remove(target, `/items/teaching_assignments/${row}`);
  }
  await settle(target);
  await publishes(context);
};

// A legacy pattern that does not compile fails the count run visibly: the
// installed counts stay and nothing is published while the counts are not
// current; the fixed pattern recounts.
export const failsInvalidPattern = async (context) => {
  const { state, t, target } = context;
  const pair = { course: 0, year: 0 };
  const { rule } = await ruleOf(context, pair);
  const before = await assertCounts(context, 'before the invalid pattern');
  await markPublicationPending(context);
  let failed;
  try {
    await setPattern(context, pair, 'Synthetic (unclosed');
    failed = await waitForStatus(
      target,
      (report) =>
        report.claim === null && report.domains.enrollments.state === 'failed',
      { limitMs: 180_000 },
    );
    assert.equal(failed.report.lastError.domain, 'enrollments');
    assert.equal(failed.report.lastError.code, 'LEGACY_COUNT_FAILED');
    assert.equal(failed.report.lastError.blocking, true);
    const kept = await installedCounts(target, state.seeded);
    assert.equal(
      countDifferences(before, kept),
      0,
      'the installed counts stay as the last completed run left them',
    );
    await refusedPublication(context, {
      code: notClaimed,
      label: 'invalid pattern',
      reason: 'upstream_dirty',
    });
  } finally {
    await setPattern(context, pair, rule.pattern);
  }
  await settlesCounted(context, 'after the fixed pattern');
  await publishes(context);
  t.diagnostic(`invalid pattern: ${failed.report.lastError.code}`);
};

// Editors, callers without a policy, anonymous callers and a reader of
// the coordination singleton run no operation and write no derived row.
export const refusesWithoutPermission = async (context) => {
  const { t, target } = context;
  const { revisions } = await status(target);
  await withAccessUsers(target, async ({ editor, plain }) => {
    for (const token of [editor, plain, null]) {
      for (const id of operationFlows) {
        const run = await runFlow(target, token, { id });
        assert.equal(run.status, 403, `${id}: ${JSON.stringify(run.body)}`);
      }
    }
    const writes = [
      ['POST', '/items/course_enrollments', { count: 1 }],
      ['POST', '/items/moodle_users', { Name: 'Synthetic Editor User' }],
      ['POST', '/items/data_operation_results', { count: 1 }],
      ['PATCH', '/items/data_operations', { import_state: 'idle' }],
    ];
    for (const [method, path, body] of writes) {
      const answer = await callAs(target, editor, { body, method, path });
      assert.equal(answer.status, 403, `${method} ${path}`);
    }
  });
  await withOperationsReader(target, async (reader) => {
    for (const id of operationFlows) {
      const run = await runFlow(target, reader, { id });
      assert.equal(run.status, 403, `${id}: ${JSON.stringify(run.body)}`);
      assert.equal(codeOf(run.body), 'FORBIDDEN');
    }
  });
  const after = await status(target);
  assert.equal(after.revisions.source, revisions.source);
  await assertIntact(context, 'refused callers');
  t.diagnostic(
    `${operationFlows.length} operations refused to an editor, a user without a policy, anonymous callers and a singleton reader`,
  );
};

// Every upload fails while the bucket folder is read-only: the objects
// keep their bytes, the outcome is failed per file, a retry converges.
export const survivesStorageFailure = async (context) => {
  const { s3, t, target } = context;
  const [row] = await get(
    target,
    '/items/rooms?fields=id,name&sort=id&limit=1',
  );
  await patch(target, `/items/rooms/${row.id}`, {
    name: `${row.name} Unreachable`,
  });
  const restore = await readOnlyBucket(s3);
  let run;
  try {
    run = await trigger(target, publishAssetsFlowId);
  } finally {
    await restore();
  }
  assert.equal(run.status, 502, JSON.stringify(run.body));
  assert.equal(codeOf(run.body), 'PUBLICATION_FAILED');
  await assertIntact(context, 'storage failure');
  const report = await status(target);
  assert.equal(report.publication.state, 'failed');
  assert.deepEqual(
    Object.keys(report.publication.files ?? {}).toSorted(),
    [...declaredFilenames].toSorted(),
  );
  for (const filename of declaredFilenames) {
    const { code, outcome } = report.publication.files[filename];
    assert.deepEqual(
      [outcome, code],
      ['failed', 'PUBLISH_UPLOAD_FAILED'],
      filename,
    );
  }
  const before = digestsOf(context.state.objects);
  await publishes(context);
  const after = digestsOf(await objectsOf(s3));
  const changed = declaredFilenames.filter((key) => before[key] !== after[key]);
  assert.deepEqual(changed, [roomsFile], 'the renamed room changes its file');
  t.diagnostic(
    `storage failure: every declared file failed (PUBLISH_UPLOAD_FAILED), objects intact; retried, only ${changed} changed`,
  );
};
