import assert from 'node:assert/strict';

import {
  checkDatabaseOf,
  checkServesTarget,
  databaseSettingNames,
} from './container-binding.js';
import { hostsOf } from './docker-ports.js';
import { dockerReads } from './docker-reads.mjs';

// The isolated targets every fixture suite takes, shared: an explicit
// disposable Directus (URL and token, loopback only, with its synthetic
// marker collection and value), and the optional Docker containers of that Directus and its database for
// the restart and read-only statistics scenarios, each shown to belong to
// the target before a suite touches it. Nothing defaults to a live
// project; a suite reports statuses and counts only.

const markerCollectionPattern = /^synthetic_search_marker_[a-z0-9]+$/u;
const markerPattern = /^synthetic-[a-z0-9-]+$/u;
const containerPattern = /^[a-z0-9][a-z0-9_.-]{0,127}$/u;

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

// The marker row must exist exactly once on the target before a suite
// writes anything.
export const assertMarkerPresent = async (target) => {
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
  const marker = JSON.parse(body);
  assert.equal(marker.data.length, 1, 'Target marker must exist exactly once');
  assert.equal(marker.data[0].marker, target.marker);
};

// One Docker container a scenario may restart or read statistics from,
// named explicitly; null when the variable is unset.
const containerOf = (environment, name) => {
  const value = environment[name];
  if (value === undefined || value === '') return null;
  assert.match(value, containerPattern, `${name} is not a container name`);
  return value;
};

export const containersFrom = (environment) => ({
  database: containerOf(environment, 'DIRECTUS_AUTOMATIC_DATABASE_CONTAINER'),
  directus: containerOf(environment, 'DIRECTUS_COORDINATION_RESTART_CONTAINER'),
});

// The containers a suite named belong to its target, read through Docker
// (`docker`, read-only commands): the Directus container publishes the
// target's port, and the database
// container is the PostgreSQL server that Directus connects to.
const bindContainers = async ({ containers, docker, target }) => {
  if (containers.directus !== null) {
    checkServesTarget(
      containers.directus,
      await docker.ports(containers.directus),
      target.base,
    );
  }
  if (containers.database === null) {
    return;
  }
  const directus = containers.directus ?? '';
  const settings = Object.fromEntries(
    await Promise.all(
      databaseSettingNames.map(async (name) => [
        name,
        await docker.setting(directus, name),
      ]),
    ),
  );
  const hosts = hostsOf(
    {
      name: containers.database,
      networks: await docker.networks(containers.database),
    },
    await docker.networks(directus),
  );
  checkDatabaseOf(containers.database, settings, hosts);
};

// Every target a suite needs, validated before it writes anything: the
// Directus target and its marker and the containers it requires. Only the required containers are
// answered, each bound to the target; the database container is bound
// through the Directus one, which it therefore requires too. `docker`
// runs the read-only Docker commands (a test passes its own).
export const isolatedTargets = async (
  environment,
  { containers: needed = [] } = {},
  docker = dockerReads,
) => {
  const target = targetFrom(environment);
  const required = new Set(
    needed.includes('database') ? [...needed, 'directus'] : needed,
  );
  const named = containersFrom(environment);
  const containers = {
    database: required.has('database') ? named.database : null,
    directus: required.has('directus') ? named.directus : null,
  };
  for (const name of required) {
    assert.ok(
      Object.hasOwn(containers, name),
      `Unknown container requirement ${name}`,
    );
    assert.ok(
      containers[name] !== null,
      `Set the ${name} container (DIRECTUS_COORDINATION_RESTART_CONTAINER, DIRECTUS_AUTOMATIC_DATABASE_CONTAINER) for this suite; it refuses to skip`,
    );
  }
  await assertMarkerPresent(target);
  await bindContainers({ containers, docker, target });
  return { containers, target };
};
