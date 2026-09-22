import type { OperationContext } from '@directus/types';

import { defineOperationApi } from '@directus/extensions-sdk';

import type { ActionContext } from './coordination/action-support.js';

import { recoverAction, runAction } from './coordination/actions.js';
import { parseCoordinatorInput } from './coordination/options.js';
import { processOwner } from './coordination/owner.js';
import {
  type SqlClient,
  type SqlDatabase,
  sqlStore,
} from './coordination/sql-port.js';
import { claimStaleAfterMs, operationId } from './coordination/state.js';
import { statusAction, type StatusReport } from './coordination/status.js';

type Database = OperationContext['database'];

const client = (database: Database): SqlClient => ({
  raw: (sql, bindings = []) => database.raw(sql, bindings),
});

// The knex handle Directus passes to operations and endpoints, narrowed to
// raw statements and one transaction scope.
export const sqlDatabase = (database: Database): SqlDatabase => ({
  ...client(database),
  transaction: (work) => database.transaction((trx) => work(client(trx))),
});

export const coordinationContext = (database: Database): ActionContext => ({
  owner: processOwner,
  staleAfterMs: claimStaleAfterMs,
  store: sqlStore(sqlDatabase(database)),
});

export const coordinate = (
  options: unknown,
  database: Database,
): Promise<unknown> =>
  runAction(parseCoordinatorInput(options), coordinationContext(database));

export const coordinationStatus = (database: Database): Promise<StatusReport> =>
  statusAction(coordinationContext(database));

export const recoverAbandonedClaim = (database: Database) =>
  recoverAction(coordinationContext(database));

export default defineOperationApi({
  handler: (options, { database }) => coordinate(options, database),
  id: operationId,
});
