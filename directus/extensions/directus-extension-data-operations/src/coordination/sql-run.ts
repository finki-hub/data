import { z } from 'zod';

import type { GuardedCollection } from './collection-roles.js';
import type { SqlBinding, SqlClient } from './sql-port.js';

import { openGuardSql } from './write-guards.js';

// The raw statement runner of the coordinator's SQL port.

const resultSchema = z.object({
  rowCount: z.number().nullable().optional(),
  rows: z.array(z.unknown()),
});

// The one wording of a missing coordination singleton, for every reader
// of it (the coordinator's and the snapshot's SQL port).
export const missingRowMessage = 'data_operations: status row missing';

export const run = async (
  client: SqlClient,
  sql: string,
  bindings: SqlBinding[] = [],
) => resultSchema.parse(await client.raw(sql, bindings));

export const affected = async (
  client: SqlClient,
  sql: string,
  bindings: SqlBinding[] = [],
): Promise<number> => {
  const result = await run(client, sql, bindings);
  return result.rowCount ?? 0;
};

// Opens the write guard of a table the coordinator writes, for its own
// transaction only.
export const openGuard = async (
  client: SqlClient,
  collection: GuardedCollection,
): Promise<void> => {
  await run(client, openGuardSql(collection));
};

export const matched = async (
  client: SqlClient,
  sql: string,
  bindings: SqlBinding[],
): Promise<boolean> => (await affected(client, sql, bindings)) > 0;

export const first = async (
  client: SqlClient,
  sql: string,
  bindings: SqlBinding[] = [],
): Promise<unknown> => {
  const result = await run(client, sql, bindings);
  const [row] = result.rows;
  if (row === undefined) {
    throw new Error(missingRowMessage);
  }
  return row;
};

export const json = (value: unknown): string => JSON.stringify(value);
