import { describe, expect, test } from 'vitest';

import {
  callerRefusal,
  requestRefusal,
} from '../directus/extensions/directus-extension-data-operations/src/access.js';

// The caller check of the data-operations endpoints and of the snapshot
// and export operations: a request without a signed-in user is answered
// 401, a signed-in user without the admin flag 403. The fixture scenario
// operations.integration.mjs checks the endpoints on a live project.

const unauthenticated = {
  message: 'Authentication required',
  reason: 'UNAUTHENTICATED',
  status: 401,
};

const forbidden = { message: 'Forbidden', reason: 'FORBIDDEN', status: 403 };

describe('the caller check', () => {
  test('answers a request without a signed-in user 401', () => {
    for (const request of [
      {},
      { accountability: null },
      { accountability: { admin: false, role: null, roles: [], user: null } },
      { accountability: { admin: true, role: null, roles: [], user: null } },
    ]) {
      expect(requestRefusal(request)).toEqual(unauthenticated);
    }
  });

  test('accepts the admin flag and answers every other signed-in user 403', () => {
    const user = { admin: false, role: 'r1', roles: ['r0', 'r1'], user: 'u1' };

    expect(
      requestRefusal({ accountability: { ...user, admin: true } }),
    ).toBeNull();
    expect(requestRefusal({ accountability: user })).toEqual(forbidden);
    expect(requestRefusal({ accountability: { ...user, role: null } })).toEqual(
      forbidden,
    );
  });

  test('reads an operation accountability the same way', () => {
    expect(callerRefusal(null)).toEqual(unauthenticated);
    expect(callerRefusal({ admin: true })).toEqual(unauthenticated);
    expect(callerRefusal({ admin: false, user: 'u1' })).toEqual(forbidden);
    expect(callerRefusal({ admin: true, user: 'u1' })).toBeNull();
  });
});
