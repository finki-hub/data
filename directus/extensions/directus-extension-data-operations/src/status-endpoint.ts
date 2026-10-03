import type { ApiExtensionContext } from '@directus/types';

import { defineEndpoint } from '@directus/extensions-sdk';
import { z } from 'zod';

import { isAdministrator } from './administrator.js';
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
import { adminOnlyText } from './text.js';

// GET /finki-hub-data-status (the data status) and
// GET /finki-hub-data-status/readiness (the readiness checks): the
// authorized status read of the dashboard. This endpoint is the access
// boundary, not the panels: an anonymous caller is answered 401, an
// authenticated caller who is no administrator 403. Everything read here
// is counts, states, codes, declared names and Studio links
// (status-contract.ts); the reads run as the system only after the caller
// was accepted.

type Access =
  | {
      readonly code: string;
      readonly message: string;
      readonly ok: false;
      readonly status: 401 | 403;
    }
  | { readonly ok: true };

const accountabilitySchema = z.looseObject({
  admin: z.boolean().optional(),
  role: z.string().nullable().optional(),
  user: z.string().nullable().optional(),
});

const unauthenticated: Access = {
  code: 'UNAUTHENTICATED',
  message: 'Authentication required',
  ok: false,
  status: 401,
};

const forbidden: Access = {
  code: 'FORBIDDEN',
  message: adminOnlyText('read the data status'),
  ok: false,
  status: 403,
};

// Who may read the status: an administrator. A request without a user and
// a role is anonymous (a null accountability is never accepted as the
// system here).
export const decideAccess = (request: object): Access => {
  const parsed = accountabilitySchema.safeParse(
    'accountability' in request ? request.accountability : null,
  );
  if (!parsed.success) {
    return unauthenticated;
  }
  const { role = null, user = null } = parsed.data;
  if (user === null && role === null) {
    return unauthenticated;
  }
  return isAdministrator(parsed.data) ? { ok: true } : forbidden;
};

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
          const access = decideAccess(request);
          if (!access.ok) {
            response
              .status(access.status)
              .json(errorBody(access.code, access.message));
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
