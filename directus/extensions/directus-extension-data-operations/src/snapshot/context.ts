import type { OperationContext } from '@directus/types';

import type { SnapshotLog } from './errors.js';
import type { SnapshotDeps } from './stage.js';

import { coordinationContext, sqlDatabase } from '../coordinate.js';
import { processOwner } from '../coordination/owner.js';
import {
  byteLimit,
  durationMs,
  heartbeatEveryMs,
  maxBytesVariable,
  timeoutVariable,
} from './contract.js';
import { snapshotFiles } from './files.js';
import { snapshotStore } from './sql-port.js';
import { markValidatingSql } from './sql.js';

const silent: SnapshotLog = {
  warn: () => {
    // No Directus logger: nothing to write to.
  },
};

// The Directus logger, narrowed to the one call the snapshot runs make.
const snapshotLog = (candidate: unknown): SnapshotLog =>
  typeof candidate === 'object' &&
  candidate !== null &&
  'warn' in candidate &&
  typeof candidate.warn === 'function'
    ? (candidate as SnapshotLog)
    : silent;

export const snapshotDeps = async (
  context: OperationContext,
): Promise<SnapshotDeps> => {
  const sql = sqlDatabase(context.database);
  const store = snapshotStore(sql);
  return {
    accountability: context.accountability,
    claims: coordinationContext(context.database),
    files: await snapshotFiles(context),
    // Its own short transaction on the pool, never the one of the backup
    // read that is open while it runs.
    heartbeat: (token) =>
      store.transaction(({ coordination }) =>
        coordination.heartbeat(token, processOwner),
      ),
    limits: {
      heartbeatMs: heartbeatEveryMs,
      maxBytes: byteLimit(context.env[maxBytesVariable]),
      timeoutMs: durationMs(context.env[timeoutVariable]),
    },
    log: snapshotLog(context.logger),
    markValidating: async (token) => {
      await sql.raw(markValidatingSql, [token]);
    },
    owner: processOwner,
    store,
  };
};
