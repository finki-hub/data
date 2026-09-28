import type { OperationContext } from '@directus/types';

import { defineOperationApi } from '@directus/extensions-sdk';
import { randomUUID } from 'node:crypto';

import type { SnapshotWarnings } from './snapshot/rows.js';

import { recoverInside } from './coordination/action-support.js';
import { snapshotDeps } from './snapshot/context.js';
import { importOptionsSchema } from './snapshot/contract.js';
import {
  importRefusal,
  parseOptions,
  requireAdmin,
} from './snapshot/decisions.js';
import {
  asSnapshotError,
  describeFailure,
  logFailure,
  recordQuietly,
} from './snapshot/errors.js';
import { type SnapshotDeps, stageFile } from './snapshot/stage.js';

const snapshotImportId = 'finki-hub-snapshot-import';

// An import older than its deadline plus this margin is treated as dead.
const importGraceMs = 60_000;

type SnapshotImportResult = {
  readonly file: string;
  readonly fingerprint: string;
  readonly rows: number;
  readonly state: 'ready';
  readonly warnings: null | SnapshotWarnings;
};

// Stages the private Moodle snapshot CSV named by its Directus file id.
// idle|ready|completed|failed -> importing -> validating -> ready, or
// failed with a bounded code and message. moodle_users is never touched:
// only the hidden staging table is replaced, inside one transaction, and
// the result is returned only after that transaction committed.
export const runSnapshotImport = async (
  options: unknown,
  deps: SnapshotDeps,
): Promise<SnapshotImportResult> => {
  requireAdmin(deps.accountability);
  const { file } = parseOptions(importOptionsSchema, options);
  const token = randomUUID();
  await deps.store.transaction(async ({ coordination, snapshot }) => {
    await coordination.ensureSingleton();
    const { state } = await recoverInside(coordination, deps.claims);
    const refusal = importRefusal(
      await snapshot.read(),
      state.claim,
      deps.limits.timeoutMs + importGraceMs,
    );
    if (refusal !== null) {
      throw refusal;
    }
    await snapshot.beginImport({ file, token });
  });
  try {
    const staged = await stageFile({ file, token }, deps);
    return { file, ...staged, state: 'ready' };
  } catch (error) {
    const failure = asSnapshotError(error, 'IMPORT_FAILED');
    logFailure(deps.log, { failure, operation: 'import' }, error);
    await recordQuietly(deps.log, () =>
      deps.store.transaction(({ snapshot }) =>
        snapshot.failRun({ error: describeFailure(failure), token }),
      ),
    );
    throw failure;
  }
};

export default defineOperationApi({
  handler: async (options, context: OperationContext) => {
    requireAdmin(context.accountability);
    return runSnapshotImport(options, await snapshotDeps(context));
  },
  id: snapshotImportId,
});
