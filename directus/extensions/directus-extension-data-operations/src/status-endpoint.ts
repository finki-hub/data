import type { ApiExtensionContext } from '@directus/types';

import { defineEndpoint } from '@directus/extensions-sdk';
import { z } from 'zod';

import { coordinationStatus, sqlDatabase } from './coordinate.js';
import { errorBody, forwardError } from './endpoint-errors.js';
import { exportDeps, itemsReader } from './exports/directus.js';
import { exportDefinitions } from './exports/index.js';
import { readinessAction } from './exports/prepare.js';
import { editorPolicy, statusEndpointId } from './managed-flows.js';
import { readinessView, reviewBookmarks } from './readiness-view.js';
import {
  type Audience,
  type ReadinessView,
  type StatusView,
} from './status-contract.js';
import {
  holdsPolicy,
  readBookmarks,
  readKeySources,
  readSchedule,
} from './status-reads.js';
import { statusView } from './status-view.js';

// GET /finki-hub-data-status (the data status) and
// GET /finki-hub-data-status/readiness (the readiness checks): the
// authorized status read of the dashboard. This endpoint is the access
// boundary, not the panels: an anonymous caller is answered 401, an
// authenticated caller who is neither an administrator nor a holder of the
// editor policy 403. Everything read here is counts, states, codes,
// declared names and Studio links (status-contract.ts); the reads run as
// the system only after the caller was accepted.

type Access =
  | { readonly audience: Audience; readonly ok: true }
  | {
      readonly code: string;
      readonly message: string;
      readonly ok: false;
      readonly status: 401 | 403;
    };

type Caller = {
  readonly roles: readonly string[];
  readonly user: null | string;
};

const accountabilitySchema = z.looseObject({
  admin: z.boolean().optional(),
  role: z.string().nullable().optional(),
  roles: z.array(z.string()).optional(),
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
  message: `Only administrators and "${editorPolicy.name}" policy holders may read the data status`,
  ok: false,
  status: 403,
};

// Who may read the status: an administrator, or a caller whose user or
// role tree holds the editor policy. A request without a user and a role
// is anonymous (a null accountability is never accepted as the system
// here).
export const decideAccess = async (
  request: object,
  holdsEditorPolicy: (caller: Caller) => Promise<boolean>,
): Promise<Access> => {
  const parsed = accountabilitySchema.safeParse(
    'accountability' in request ? request.accountability : null,
  );
  if (!parsed.success) {
    return unauthenticated;
  }
  const { admin, role = null, roles = [], user = null } = parsed.data;
  if (user === null && role === null) {
    return unauthenticated;
  }
  if (admin === true) {
    return { audience: 'administrator', ok: true };
  }
  return (await holdsEditorPolicy({ roles, user }))
    ? { audience: 'editor', ok: true }
    : forbidden;
};

const readStatus = async (
  context: ApiExtensionContext,
  audience: Audience,
): Promise<StatusView> => {
  const report = await coordinationStatus(context.database);
  const keySources = await readKeySources(await itemsReader(context));
  const schedule = await readSchedule(sqlDatabase(context.database));
  return statusView({
    audience,
    keySources,
    report,
    schedule,
  });
};

const readReadiness = async (
  context: ApiExtensionContext,
  audience: Audience,
): Promise<ReadinessView> => {
  const answer = await readinessAction(
    exportDefinitions,
    await exportDeps(context),
  );
  const bookmarks = await readBookmarks(
    sqlDatabase(context.database),
    reviewBookmarks(),
  );
  return readinessView({ answer, audience, bookmarks });
};

export default defineEndpoint({
  handler: (router, context) => {
    const sql = sqlDatabase(context.database);
    const holds = (caller: Caller) => holdsPolicy(sql, editorPolicy.id, caller);
    const serve = (
      path: string,
      read: (audience: Audience) => Promise<unknown>,
    ) => {
      router.get(path, async (request, response, next) => {
        response.setHeader('Cache-Control', 'no-store');
        try {
          const access = await decideAccess(request, holds);
          if (!access.ok) {
            response
              .status(access.status)
              .json(errorBody(access.code, access.message));
            return;
          }
          response.json({ data: await read(access.audience) });
        } catch (error) {
          forwardError(next, error);
        }
      });
    };
    serve('/', (audience) => readStatus(context, audience));
    serve('/readiness', (audience) => readReadiness(context, audience));
  },
  id: statusEndpointId,
});
