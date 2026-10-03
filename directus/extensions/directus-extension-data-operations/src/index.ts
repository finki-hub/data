import { defineEndpoint } from '@directus/extensions-sdk';

import { isAdministrator } from './administrator.js';
import { coordinationStatus, sqlDatabase } from './coordinate.js';
import { errorBody, forwardError } from './endpoint-errors.js';
import {
  findMigration,
  isMigrationName,
  type Migration,
  migrations,
} from './migrations.js';
import { snapshotReport } from './snapshot/report.js';
import { snapshotStore } from './snapshot/sql-port.js';
import { adminOnlyText } from './text.js';

type SqlRunner = {
  readonly raw: (sql: string) => PromiseLike<unknown>;
};

// True only for a request whose resolved accountability is an administrator.
export const isAdminRequest = (request: object): boolean =>
  'accountability' in request && isAdministrator(request.accountability);

// Runs every statement of the migration in order and returns how many ran.
export const executeMigration = async (
  runner: SqlRunner,
  migration: Migration,
): Promise<number> => {
  let executed = 0;
  for (const statement of migration.statements) {
    await runner.raw(statement);
    executed += 1;
  }
  return executed;
};

// The refusal of an unknown migration: its name when it is one a
// migration could carry (never other request text), then the bundled ones.
export const unknownMigrationText = (name: string): string => {
  const named = isMigrationName(name) ? `: ${name}` : '';
  const available = migrations.map((migration) => migration.name).join(', ');
  return `Unknown migration${named}; available: ${available}`;
};

export default defineEndpoint((router, { database }) => {
  router.use((request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!isAdminRequest(request)) {
      response
        .status(403)
        .json(errorBody('FORBIDDEN', adminOnlyText('run data operations')));
      return;
    }
    next();
  });

  router.post('/migrations/:name', async (request, response, next) => {
    try {
      const migration = findMigration(request.params.name);
      if (migration === undefined) {
        response
          .status(400)
          .json(
            errorBody(
              'INVALID_PAYLOAD',
              unknownMigrationText(request.params.name),
            ),
          );
        return;
      }
      const statements = await database.transaction((trx) =>
        executeMigration(trx, migration),
      );
      response.json({ data: { applied: migration.name, statements } });
    } catch (error) {
      forwardError(next, error);
    }
  });

  // The bounded coordination status: revisions, pending domains, the
  // current claim without its token, the last failure and the fingerprints.
  router.get('/status', async (_request, response, next) => {
    try {
      response.json({ data: await coordinationStatus(database) });
    } catch (error) {
      forwardError(next, error);
    }
  });

  // The Moodle snapshot import and promotion status: counts and
  // fingerprints of the staged, the active and the last promoted
  // snapshot, the backup, the last error; no row data.
  router.get('/snapshot', async (_request, response, next) => {
    try {
      response.json({
        data: await snapshotReport(snapshotStore(sqlDatabase(database))),
      });
    } catch (error) {
      forwardError(next, error);
    }
  });
});
