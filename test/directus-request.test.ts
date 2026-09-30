import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createDirectusRequest,
  DirectusRequestError,
} from '../src/directus-request.js';
import { config } from './directus-test-helpers.js';

afterEach(() => vi.unstubAllGlobals());

const failureOf = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
    return null;
  } catch (error) {
    return error;
  }
};

describe('Directus request errors', () => {
  test('name the request, the status, the code and the reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        Response.json(
          {
            errors: [
              {
                extensions: { code: 'INVALID_CREDENTIALS' },
                message: 'Invalid user credentials.',
              },
            ],
          },
          { status: 401 },
        ),
      ),
    );

    const failure = await failureOf(
      createDirectusRequest(config)('/collections?limit=-1'),
    );

    expect(failure).toBeInstanceOf(DirectusRequestError);
    expect(failure).toMatchObject({
      code: 'INVALID_CREDENTIALS',
      message:
        'GET /collections: HTTP 401 INVALID_CREDENTIALS: Invalid user credentials.',
      reason: 'Invalid user credentials.',
      status: 401,
    });
  });

  test('quote the start of a body that is no Directus error, on one line', async () => {
    const page = `<html>\n  <body>${'Bad gateway '.repeat(40)}</body>\n</html>`;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => new Response(page, { status: 502 })),
    );

    const failure = await failureOf(
      createDirectusRequest(config)('/items/courses', { method: 'POST' }),
    );
    const message = failure instanceof Error ? failure.message : '';

    expect(
      message.startsWith(
        'POST /items/courses: HTTP 502: <html> <body>Bad gateway',
      ),
    ).toBeTruthy();
    expect(message).toHaveLength(
      'POST /items/courses: HTTP 502: '.length + 200,
    );
    expect(failure).toMatchObject({ code: null, reason: null, status: 502 });
  });

  test('name a request that got no response by the cause code', async () => {
    const refused = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
        code: 'ECONNREFUSED',
      }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => {
        throw refused;
      }),
    );

    const failure = await failureOf(
      createDirectusRequest(config)('/collections'),
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      cause: refused,
      message: 'GET /collections: no response (ECONNREFUSED)',
    });
  });

  test('name a request that timed out', async () => {
    const timeout = new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => {
        throw timeout;
      }),
    );

    const failure = await failureOf(
      createDirectusRequest(config)('/settings', { method: 'PATCH' }),
    );

    expect(failure).toMatchObject({
      cause: timeout,
      message: 'PATCH /settings: timed out after 120 s',
    });
  });
});
