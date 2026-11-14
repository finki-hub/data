import assert from 'node:assert/strict';

import { destroySearchFixture, withCleanup } from './search-cleanup.mjs';
import { collectionDefinition, moodleUsers } from './search-fixture.mjs';

const endpoint = '/finki-hub-course-history';

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
  return status === 204 ? null : httpResponse.json();
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

const setupSearchFixture = async (target) => {
  let fixture = { collection: false };
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
    fixture = { collection: true };
    await read(
      await request(
        target,
        '/items/moodle_users',
        json(moodleUsers, target.token),
      ),
      200,
    );
    return { teardown: () => destroySearchFixture(target, fixture) };
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

export const withSearchFixture = async (target, body) => {
  const fixture = await setupSearchFixture(target);
  return withCleanup(body, fixture.teardown);
};

export const options = (target, token) =>
  request(target, `${endpoint}/options`, { token });
export const response = read;
