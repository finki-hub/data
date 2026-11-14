import assert from 'node:assert/strict';
import { z } from 'zod';

// The isolated target the fixture suites (search, CSV import) take: an
// explicit disposable Directus (URL and token, loopback only) with its
// synthetic marker collection and value, validated before a suite writes
// anything. Nothing defaults to a live project; DIRECTUS_URL or
// DIRECTUS_ADMIN_TOKEN alone never name a target.

export type IsolatedTarget = {
  readonly base: URL;
  readonly marker: string;
  readonly markerCollection: string;
  readonly token: string;
};

type Environment = Readonly<Record<string, string | undefined>>;

const markerCollectionPattern = /^synthetic_search_marker_[a-z0-9]+$/u;
const markerPattern = /^synthetic-[a-z0-9-]+$/u;
const loopbackHosts = new Set(['127.0.0.1', '[::1]']);

export const targetFrom = (environment: Environment): IsolatedTarget => {
  const url = environment['DIRECTUS_SEARCH_TEST_URL'];
  const token = environment['DIRECTUS_SEARCH_TEST_TOKEN'];
  const markerCollection =
    environment['DIRECTUS_SEARCH_TEST_MARKER_COLLECTION'];
  const marker = environment['DIRECTUS_SEARCH_TEST_MARKER_VALUE'];
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
    loopbackHosts.has(base.hostname),
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

const markerRows = z.object({
  data: z.array(z.object({ marker: z.string() })),
});

// The marker row must exist exactly once on the target before a suite
// writes anything.
export const assertMarkerPresent = async (
  target: IsolatedTarget,
): Promise<void> => {
  const response = await fetch(
    new URL(
      `/items/${target.markerCollection}?filter[marker][_eq]=${encodeURIComponent(target.marker)}&limit=2`,
      target.base,
    ),
    {
      headers: { authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(60_000),
    },
  );
  const body = await response.text();
  assert.equal(response.status, 200, `the marker read answered ${body}`);
  const { data } = markerRows.parse(JSON.parse(body));
  assert.equal(data.length, 1, 'Target marker must exist exactly once');
  assert.equal(data[0]?.marker, target.marker);
};

// The validated target, its marker checked.
export const isolatedTarget = async (
  environment: Environment,
): Promise<IsolatedTarget> => {
  const target = targetFrom(environment);
  await assertMarkerPresent(target);
  return target;
};
