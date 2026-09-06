import assert from 'node:assert/strict';

const deleteResource = async (target, path) => {
  const result = await fetch(new URL(path, target.base), {
    headers: { authorization: `Bearer ${target.token}` },
    method: 'DELETE',
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(result.status, 204, `${path} cleanup returned ${result.status}`);
};

const resourcePaths = (fixture) => [
  ...(fixture.user ? [`/users/${fixture.user}`] : []),
  ...(fixture.permission ? [`/permissions/${fixture.permission}`] : []),
  ...(fixture.access ? [`/access/${fixture.access}`] : []),
  ...(fixture.role ? [`/roles/${fixture.role}`] : []),
  ...(fixture.policy ? [`/policies/${fixture.policy}`] : []),
  ...(fixture.collection ? ['/collections/moodle_users'] : []),
];

export const destroySearchFixture = async (target, fixture) => {
  const failures = [];
  for (const path of resourcePaths(fixture)) {
    try {
      await deleteResource(target, path);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      'Search fixture cleanup did not remove every resource',
    );
  }
};

export const withCleanup = async (body, cleanup) => {
  let result;
  let failure;
  let failed = false;
  try {
    result = await body();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    if (failed) {
      throw new AggregateError(
        [failure, cleanupError],
        'Search test failed and fixture cleanup did not complete',
        { cause: cleanupError },
      );
    }
    throw cleanupError;
  }
  if (failed) throw failure;
  return result;
};
