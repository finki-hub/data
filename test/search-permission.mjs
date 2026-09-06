import assert from 'node:assert/strict';

export const setRestrictedFields = async (target, permission, fields) => {
  const result = await fetch(
    new URL(`/permissions/${permission}`, target.base),
    {
      body: JSON.stringify({ fields }),
      headers: {
        authorization: `Bearer ${target.token}`,
        'content-type': 'application/json',
      },
      method: 'PATCH',
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert.equal(
    result.status,
    200,
    `permission update returned ${result.status}`,
  );
  return result.json();
};
