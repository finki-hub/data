import type { OperationContext } from '@directus/types';

import { defineOperationApi } from '@directus/extensions-sdk';
import { randomUUID } from 'node:crypto';

import type { BackupRecord, SnapshotPorts } from './snapshot/port.js';

import { recoverInside } from './coordination/action-support.js';
import { currentFor, verifyOwnership } from './coordination/decisions.js';
import { ClaimKeeper, writeBackup } from './snapshot/backup.js';
import { snapshotDeps } from './snapshot/context.js';
import {
  activeTable,
  type PromoteOptions,
  promoteOptionsSchema,
  stagingTable,
} from './snapshot/contract.js';
import {
  parseOptions,
  promotionRefusal,
  requireAdmin,
} from './snapshot/decisions.js';
import {
  asSnapshotError,
  claimBusy,
  claimLost,
  describeFailure,
  logFailure,
  recordQuietly,
  snapshotError,
} from './snapshot/errors.js';
import { type SnapshotDeps } from './snapshot/stage.js';
import { countText } from './text.js';

const snapshotPromoteId = 'finki-hub-snapshot-promote';

type Run = {
  readonly backup: BackupRecord;
  readonly claimToken: string;
  readonly deps: SnapshotDeps;
  readonly options: PromoteOptions;
  readonly token: string;
};

type SnapshotPromotionResult = {
  readonly backup: BackupRecord;
  readonly membershipsRemoved: number;
  readonly pending: readonly string[];
  readonly previousRows: number;
  readonly revision: number;
  readonly rows: number;
  readonly state: 'completed';
};

// The one replacement transaction. Writers of moodle_users are held off by
// the table lock and every coordinator by the singleton lock, while
// readers keep seeing the previous rows until the commit. The staged rows
// must still be the confirmed ones and the active rows exactly the backed
// up ones; then memberships and users are replaced, the new rows must
// fingerprint like the staged ones, the staging is emptied and the state,
// the pending revision (written by the moodle_users trigger) and the
// release of the snapshot claim commit together.
const replace = async ({ coordination, snapshot }: SnapshotPorts, run: Run) => {
  await snapshot.boundStatements(run.deps.limits.timeoutMs);
  await snapshot.lockActive();
  const operations = await coordination.readState(true);
  const owned = verifyOwnership(operations, {
    owner: run.deps.owner,
    token: run.claimToken,
  });
  if (owned !== 'ok') {
    throw claimLost('promotion');
  }
  const current = await snapshot.read();
  const staged = await snapshot.summary(stagingTable);
  if (
    current.token !== run.token ||
    current.fingerprint !== run.options.staging_fingerprint ||
    staged.rows !== current.rows ||
    staged.fingerprint !== current.fingerprint
  ) {
    throw snapshotError(
      'STAGING_CHANGED',
      'Staged snapshot changed after confirmation',
    );
  }
  const active = await snapshot.summary(activeTable);
  if (
    active.rows !== run.backup.rows ||
    active.fingerprint !== run.backup.fingerprint
  ) {
    throw snapshotError(
      'ACTIVE_CHANGED',
      'Active Moodle users changed after backup',
    );
  }
  const replaced = await snapshot.replaceActive();
  const promoted = await snapshot.summary(activeTable);
  if (
    replaced.removed !== active.rows ||
    replaced.inserted !== staged.rows ||
    promoted.rows !== staged.rows ||
    promoted.fingerprint !== staged.fingerprint
  ) {
    throw snapshotError(
      'COUNT_MISMATCH',
      `Replacement mismatch: active ${countText(promoted.rows, 'row', 'rows')}, staged ${countText(staged.rows, 'row', 'rows')}`,
    );
  }
  await snapshot.openStagingWriter();
  await snapshot.clearStaging();
  const completed = await snapshot.completePromotion({
    claimToken: run.claimToken,
    owner: run.deps.owner,
    promoted,
    token: run.token,
  });
  if (!completed) {
    throw claimLost('promotion');
  }
  const after = await coordination.readState(false);
  return {
    membershipsRemoved: replaced.memberships,
    pending: after.dirtyDomains,
    previousRows: active.rows,
    revision: after.sourceRevision,
    rows: staged.rows,
  };
};

// Replaces the active Moodle snapshot with the staged one under an
// exclusive `snapshot` claim of the coordinator: ready -> promoting ->
// completed, or failed with active users, memberships and counts
// untouched. The private backup of the active rows is written and
// verified before the replacement starts, heartbeating the claim. A
// failure is recorded in import_state and import_error only: releasing a
// snapshot claim never touches the coordinator's failure of a work domain.
export const runSnapshotPromotion = async (
  options: unknown,
  deps: SnapshotDeps,
): Promise<SnapshotPromotionResult> => {
  requireAdmin(deps.accountability);
  const input = parseOptions(promoteOptionsSchema, options);
  const claimToken = randomUUID();
  const token = randomUUID();
  await deps.store.transaction(async ({ coordination, snapshot }) => {
    await coordination.ensureSingleton();
    const { state } = await recoverInside(coordination, deps.claims);
    const refusal = promotionRefusal(state, await snapshot.read(), input);
    if (refusal !== null) {
      throw refusal;
    }
    const taken = await coordination.takeClaim({
      dirtyDomains: state.dirtyDomains,
      domain: 'snapshot',
      fingerprint: currentFor(
        await coordination.currentFingerprints(),
        'snapshot',
      ),
      owner: deps.owner,
      sourceRevision: state.sourceRevision,
      token: claimToken,
    });
    if (!taken) {
      throw claimBusy();
    }
    await snapshot.beginPromotion(token);
  });
  try {
    const backup = await writeBackup(deps, new ClaimKeeper(deps, claimToken));
    await deps.store.transaction(async ({ coordination, snapshot }) => {
      await coordination.readState(true);
      const kept =
        (await coordination.heartbeat(claimToken, deps.owner)) &&
        (await snapshot.recordBackup({ backup, token }));
      if (!kept) {
        throw claimLost('backup');
      }
    });
    const result = await deps.store.transaction((ports) =>
      replace(ports, { backup, claimToken, deps, options: input, token }),
    );
    return { backup, ...result, state: 'completed' };
  } catch (error) {
    const failure = asSnapshotError(error, 'PROMOTION_FAILED');
    logFailure(deps.log, { failure, operation: 'promotion' }, error);
    await recordQuietly(deps.log, () =>
      deps.store.transaction(async ({ coordination, snapshot }) => {
        await coordination.readState(true);
        await coordination.release({
          code: failure.code,
          failed: true,
          token: claimToken,
        });
        await snapshot.failRun({ error: describeFailure(failure), token });
      }),
    );
    throw failure;
  }
};

export default defineOperationApi({
  handler: async (options, context: OperationContext) => {
    requireAdmin(context.accountability);
    return runSnapshotPromotion(options, await snapshotDeps(context));
  },
  id: snapshotPromoteId,
});
