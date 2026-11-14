import assert from 'node:assert/strict';
import { z } from 'zod';

import type { IsolatedTarget } from './isolated-target.js';

import { collectionDefinition, moodleUsers } from './search-fixture.js';

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

// Requests to the course-search endpoint of an isolated target, and the
// synthetic moodle_users collection its tests search: created for one
// test and removed afterwards, also when the test fails.

const endpoint = '/finki-hub-course-history';

type RequestOptions = FetchInit & { readonly token?: null | string };

const request = (
  target: IsolatedTarget,
  path: string,
  { token = null, ...init }: RequestOptions = {},
): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (token !== null) {
    headers.set('authorization', `Bearer ${token}`);
  }
  return fetch(new URL(path, target.base), {
    ...init,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
};

// The JSON body of a response with the expected status.
export const response = async (
  httpResponse: Response,
  status: number,
): Promise<unknown> => {
  if (httpResponse.status !== status) {
    const body = await httpResponse.text();
    assert.fail(
      `${httpResponse.url} returned HTTP ${String(httpResponse.status)}: ${body}`,
    );
  }
  return status === 204 ? null : httpResponse.json();
};

const json = (body: unknown, token: null | string = null): RequestOptions => ({
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
  method: 'POST',
  token,
});

const searchRow = z.looseObject({
  'Courses Count': z.number().nullable(),
  Name: z.string(),
  Profile_new: z.string().nullish(),
  Profile_old: z.string().nullish(),
});

export type SearchRow = z.infer<typeof searchRow>;

const searchResult = z.object({ data: z.array(searchRow), total: z.number() });

export type SearchResult = z.infer<typeof searchResult>;

export const searchResponse = (
  target: IsolatedTarget,
  token: string,
  criteria: unknown,
): Promise<Response> =>
  request(target, `${endpoint}/search`, json(criteria, token));

export const search = async (
  target: IsolatedTarget,
  token: string,
  criteria: unknown,
): Promise<SearchResult> =>
  searchResult.parse(
    await response(await searchResponse(target, token, criteria), 200),
  );

export const anonymousSearch = (
  target: IsolatedTarget,
  body: unknown,
): Promise<Response> => request(target, `${endpoint}/search`, json(body));

export const options = (
  target: IsolatedTarget,
  token: null | string = null,
): Promise<Response> => request(target, `${endpoint}/options`, { token });

// Runs `body`, then `cleanup`, and reports both failures together.
export const withCleanup = async <T>(
  body: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> => {
  let outcome: { readonly error: unknown } | { readonly value: T };
  try {
    outcome = { value: await body() };
  } catch (error) {
    outcome = { error };
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    if ('error' in outcome) {
      throw new AggregateError(
        [outcome.error, cleanupError],
        'Search test failed and fixture cleanup did not complete',
        { cause: cleanupError },
      );
    }
    throw cleanupError;
  }
  if ('error' in outcome) {
    throw outcome.error;
  }
  return outcome.value;
};

const removeCollection = async (target: IsolatedTarget): Promise<void> => {
  const result = await request(target, '/collections/moodle_users', {
    method: 'DELETE',
    token: target.token,
  });
  assert.equal(
    result.status,
    204,
    `moodle_users cleanup returned ${String(result.status)}`,
  );
};

const markerRows = z.object({
  data: z.array(z.object({ marker: z.string() })),
});

// Creates the synthetic moodle_users collection and its users on the
// marked target; answers how to remove it.
const setupSearchFixture = async (
  target: IsolatedTarget,
): Promise<() => Promise<void>> => {
  let created = false;
  const teardown = async () => {
    if (created) {
      await removeCollection(target);
    }
  };
  try {
    const { data } = markerRows.parse(
      await response(
        await request(
          target,
          `/items/${target.markerCollection}?filter[marker][_eq]=${encodeURIComponent(target.marker)}&limit=2`,
          { token: target.token },
        ),
        200,
      ),
    );
    assert.deepEqual(
      data.map(({ marker }) => marker),
      [target.marker],
      'Target marker must exist exactly once before fixture creation',
    );
    await response(
      await request(
        target,
        '/collections',
        json(collectionDefinition, target.token),
      ),
      200,
    );
    created = true;
    await response(
      await request(
        target,
        '/items/moodle_users',
        json(moodleUsers, target.token),
      ),
      200,
    );
    return teardown;
  } catch (error) {
    try {
      await teardown();
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

export const withSearchFixture = async <T>(
  target: IsolatedTarget,
  body: () => Promise<T>,
): Promise<T> => withCleanup(body, await setupSearchFixture(target));
