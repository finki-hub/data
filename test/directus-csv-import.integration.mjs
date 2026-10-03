import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { isolatedTargets } from './isolated-target.mjs';

// Checks the UTF-8 fix of the local image (directus/patch-csv-import.cjs)
// through Directus's native CSV import. Like every fixture suite it takes
// only the explicit disposable target (DIRECTUS_SEARCH_TEST_URL, _TOKEN,
// _MARKER_COLLECTION and _MARKER_VALUE: a loopback URL, a token and the
// synthetic marker, validated before any request). It never reads .env and
// has no default URL, so DIRECTUS_URL, DIRECTUS_TOKEN or
// DIRECTUS_ADMIN_TOKEN alone never point it at a project.

const missingTargetPattern = /DIRECTUS_SEARCH_TEST_URL/u;

// Docker must not be asked anything: the suite needs no container.
const noDocker = {
  networks: () => assert.fail('no Docker command'),
  ports: () => assert.fail('no Docker command'),
  setting: () => assert.fail('no Docker command'),
};

test('refuses a target named only by the lifecycle variables', async () => {
  await assert.rejects(
    isolatedTargets(
      {
        DIRECTUS_ADMIN_TOKEN: 'synthetic-token',
        DIRECTUS_TOKEN: 'synthetic-token',
        DIRECTUS_URL: 'http://127.0.0.1:18055',
      },
      {},
      noDocker,
    ),
    missingTargetPattern,
  );
});

test('native CSV import preserves UTF-8 across file read boundaries', async () => {
  const { target } = await isolatedTargets(process.env, {}, noDocker);
  const collection = `csv_utf8_test_${randomUUID().replaceAll('-', '')}`;
  const request = async (path, options = {}) => {
    const response = await fetch(new URL(path, target.base), {
      ...options,
      headers: {
        authorization: `Bearer ${target.token}`,
        ...options.headers,
      },
      signal: AbortSignal.timeout(60_000),
    });
    assert.ok(
      response.ok,
      `${options.method ?? 'GET'} ${path}: HTTP ${response.status}`,
    );
    return response;
  };

  await request('/collections', {
    body: JSON.stringify({
      collection,
      fields: [
        {
          field: 'id',
          schema: { has_auto_increment: true, is_primary_key: true },
          type: 'integer',
        },
        { field: 'value', type: 'text' },
      ],
      meta: { hidden: true },
      schema: {},
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  try {
    const values = [
      `a${'Ж'.repeat(40_000)}`,
      '漢'.repeat(40_000),
      '😀'.repeat(40_000),
    ];
    const form = new FormData();
    form.append(
      'file',
      new Blob([`value\n${values.join('\n')}\n`], { type: 'text/csv' }),
      'synthetic.csv',
    );
    await request(`/utils/import/${collection}`, {
      body: form,
      method: 'POST',
    });
    const response = await request(`/items/${collection}?sort=id&limit=-1`);
    const { data } = await response.json();
    assert.equal(data.length, values.length);
    assert.ok(
      data.every((row, index) => row.value === values[index]),
      'Imported Unicode differs from the synthetic CSV',
    );
  } finally {
    await request(`/collections/${collection}`, { method: 'DELETE' });
  }
});
