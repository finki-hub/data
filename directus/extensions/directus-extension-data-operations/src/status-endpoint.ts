import type { ApiExtensionContext } from '@directus/types';

import { defineEndpoint } from '@directus/extensions-sdk';

import { requestRefusal } from './access.js';
import { coordinationStatus, sqlDatabase } from './coordinate.js';
import { errorBody, forwardError } from './endpoint-errors.js';
import { exportDeps, itemsReader } from './exports/directus.js';
import { exportDefinitions } from './exports/index.js';
import { readinessAction } from './exports/prepare.js';
import { statusEndpointId } from './managed-flows.js';
import { readinessView, reviewBookmarks } from './readiness-view.js';
import { type ReadinessView, type StatusView } from './status-contract.js';
import { readBookmarks, readKeySources, readSchedule } from './status-reads.js';
import { statusView } from './status-view.js';

// GET /finki-hub-data-status (the data status) and
// GET /finki-hub-data-status/readiness (the readiness checks): the status
// read of the dashboard. The caller check (access.ts) runs first; the
// reads then run as the system. Everything answered is counts, states,
// codes, declared names and Studio links (status-contract.ts).

const readStatus = async (
  context: ApiExtensionContext,
): Promise<StatusView> => {
  const report = await coordinationStatus(context.database);
  const keySources = await readKeySources(await itemsReader(context));
  const schedule = await readSchedule(sqlDatabase(context.database));
  return statusView({ keySources, report, schedule });
};

const readReadiness = async (
  context: ApiExtensionContext,
): Promise<ReadinessView> => {
  const answer = await readinessAction(
    exportDefinitions,
    await exportDeps(context),
  );
  const bookmarks = await readBookmarks(
    sqlDatabase(context.database),
    reviewBookmarks(),
  );
  return readinessView({ answer, bookmarks });
};

export default defineEndpoint({
  handler: (router, context) => {
    const serve = (path: string, read: () => Promise<unknown>) => {
      router.get(path, async (request, response, next) => {
        response.setHeader('Cache-Control', 'no-store');
        try {
          const refusal = requestRefusal(request);
          if (refusal !== null) {
            response
              .status(refusal.status)
              .json(errorBody(refusal.reason, refusal.message));
            return;
          }
          response.json({ data: await read() });
        } catch (error) {
          forwardError(next, error);
        }
      });
    };
    serve('/', () => readStatus(context));
    serve('/readiness', () => readReadiness(context));
  },
  id: statusEndpointId,
});
