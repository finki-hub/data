import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { destroySearchFixture, withCleanup } from './search-cleanup.mjs';
import { collectionDefinition, moodleUsers } from './search-fixture.mjs';
import { setRestrictedFields } from './search-permission.mjs';

const markerCollectionPattern = /^synthetic_search_marker_[a-z0-9]+$/u;
const markerPattern = /^synthetic-[a-z0-9-]+$/u;
const endpoint = '/finki-hub-course-history';

export const targetFrom = (environment) => {
  const url = environment.DIRECTUS_SEARCH_TEST_URL;
  const token = environment.DIRECTUS_SEARCH_TEST_TOKEN;
  const markerCollection = environment.DIRECTUS_SEARCH_TEST_MARKER_COLLECTION;
  const marker = environment.DIRECTUS_SEARCH_TEST_MARKER_VALUE;
  assert.ok(
    url,
    'Set DIRECTUS_SEARCH_TEST_URL to an explicit disposable target',
  );
  assert.ok(
    token,
    'Set DIRECTUS_SEARCH_TEST_TOKEN to a disposable-target token',
  );
  assert.ok(markerCollection, 'Set DIRECTUS_SEARCH_TEST_MARKER_COLLECTION');
  assert.ok(marker, 'Set DIRECTUS_SEARCH_TEST_MARKER_VALUE');
  const base = new URL(url);
  assert.ok(
    base.protocol === 'http:' || base.protocol === 'https:',
    'Target URL must use HTTP(S)',
  );
  assert.ok(
    ['127.0.0.1', '[::1]'].includes(base.hostname),
    'Target URL must be loopback-only',
  );
  assert.equal(base.pathname, '/', 'Target URL must not include a path');
  assert.match(
    markerCollection,
    markerCollectionPattern,
    'Marker collection is not disposable',
  );
  assert.match(marker, markerPattern, 'Marker value is not synthetic');
  return { base, marker, markerCollection, token };
};

const request = (target, path, requestOptions = {}) => {
  const headers = new Headers(requestOptions.headers);
  if (requestOptions.token)
    headers.set('authorization', `Bearer ${requestOptions.token}`);
  return fetch(new URL(path, target.base), {
    ...requestOptions,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
};

const read = async (httpResponse, status) => {
  if (httpResponse.status !== status) {
    const body = await httpResponse.text();
    assert.fail(
      `${httpResponse.url} returned HTTP ${httpResponse.status}: ${body}`,
    );
  }
  if (status === 204) return null;
  return httpResponse.json();
};

const json = (body, token = null) => ({
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
  method: 'POST',
  token,
});

export const searchResponse = (target, token, criteria) =>
  request(target, `${endpoint}/search`, json(criteria, token));

export const search = async (target, token, criteria) =>
  read(await searchResponse(target, token, criteria), 200);

export const anonymousSearch = (target, body) =>
  request(target, `${endpoint}/search`, json(body));

export const setupSearchFixture = async (
  target,
  withRestrictedAccess = false,
) => {
  let fixture = {
    access: undefined,
    collection: false,
    permission: undefined,
    policy: undefined,
    role: undefined,
    user: undefined,
  };
  try {
    const marker = await read(
      await request(
        target,
        `/items/${target.markerCollection}?filter[marker][_eq]=${encodeURIComponent(target.marker)}&limit=2`,
        { token: target.token },
      ),
      200,
    );
    assert.equal(
      marker.data.length,
      1,
      'Target marker must exist exactly once before fixture creation',
    );
    assert.equal(
      marker.data[0].marker,
      target.marker,
      'Target marker does not match the requested synthetic target',
    );
    await read(
      await request(
        target,
        '/collections',
        json(collectionDefinition, target.token),
      ),
      200,
    );
    fixture = { ...fixture, collection: true };
    if (!withRestrictedAccess) {
      await read(
        await request(
          target,
          '/items/moodle_users',
          json(moodleUsers, target.token),
        ),
        200,
      );
      return { teardown: () => destroySearchFixture(target, fixture) };
    }
    const policy = await read(
      await request(
        target,
        '/policies',
        json(
          {
            admin_access: false,
            app_access: false,
            name: `Search restriction ${randomUUID()}`,
          },
          target.token,
        ),
      ),
      200,
    );
    fixture = { ...fixture, policy: policy.data.id };
    const role = await read(
      await request(
        target,
        '/roles',
        json(
          {
            icon: 'lock',
            name: `Search restriction ${randomUUID()}`,
          },
          target.token,
        ),
      ),
      200,
    );
    fixture = { ...fixture, role: role.data.id };
    const access = await read(
      await request(
        target,
        '/access',
        json({ policy: fixture.policy, role: fixture.role }, target.token),
      ),
      200,
    );
    fixture = { ...fixture, access: access.data.id };
    const permission = await read(
      await request(
        target,
        '/permissions',
        json(
          {
            action: 'read',
            collection: 'moodle_users',
            fields: [
              'id',
              'Name',
              'Mail',
              'Profile_new',
              'Profile_old',
              'Courses',
              'Courses Count',
            ],
            permissions: { Name: { _eq: 'Visible Searcher' } },
            policy: fixture.policy,
            presets: {},
            validation: {},
          },
          target.token,
        ),
      ),
      200,
    );
    fixture = { ...fixture, permission: permission.data.id };
    await read(
      await request(
        target,
        '/items/moodle_users',
        json(moodleUsers, target.token),
      ),
      200,
    );
    const login = {
      email: `search-restricted-${randomUUID()}@example.com`,
      password: randomUUID(),
    };
    const user = await read(
      await request(
        target,
        '/users',
        json(
          {
            email: login.email,
            password: login.password,
            role: fixture.role,
            status: 'active',
          },
          target.token,
        ),
      ),
      200,
    );
    fixture = { ...fixture, user: user.data.id };
    const session = await read(
      await request(target, '/auth/login', json(login)),
      200,
    );
    return {
      restrictedToken: session.data.access_token,
      setRestrictedFields: (fields) =>
        setRestrictedFields(target, fixture.permission, fields),
      teardown: () => destroySearchFixture(target, fixture),
    };
  } catch (error) {
    try {
      await destroySearchFixture(target, fixture);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Search fixture setup failed and cleanup did not complete',
        { cause: cleanupError },
      );
    }
    throw error;
  }
};

export const withSearchFixture = async (target, withRestrictedAccess, body) => {
  const fixture = await setupSearchFixture(target, withRestrictedAccess);
  return withCleanup(() => body(fixture), fixture.teardown);
};

export const options = (target, token) =>
  request(target, `${endpoint}/options`, { token });
export const response = read;
