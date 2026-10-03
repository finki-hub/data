import { describe, expect, test } from 'vitest';

import { decideAccess } from '../directus/extensions/directus-extension-data-operations/src/status-endpoint.js';

// The access boundary of the status read: anonymous callers are answered
// 401, authenticated callers who are no administrator 403. The fixture
// scenario operations.integration.mjs checks the endpoint on a live
// project.

describe('the status read access boundary', () => {
  test('answers an anonymous caller 401', () => {
    for (const request of [
      {},
      { accountability: null },
      { accountability: { admin: false, role: null, roles: [], user: null } },
      { accountability: { admin: true, role: null, roles: [], user: null } },
    ]) {
      expect(decideAccess(request)).toMatchObject({ ok: false, status: 401 });
    }
  });

  test('lets an administrator in and refuses every other caller 403', () => {
    const user = { admin: false, role: 'r1', roles: ['r0', 'r1'], user: 'u1' };

    expect(decideAccess({ accountability: { ...user, admin: true } })).toEqual({
      ok: true,
    });
    expect(decideAccess({ accountability: user })).toMatchObject({
      code: 'FORBIDDEN',
      ok: false,
      status: 403,
    });
    expect(
      decideAccess({ accountability: { ...user, role: null } }),
    ).toMatchObject({ code: 'FORBIDDEN', ok: false, status: 403 });
  });
});
