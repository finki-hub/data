import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { z } from 'zod';

import { isolatedTarget } from './isolated-target.js';

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

// Checks the UTF-8 fix of the image (directus/patch-csv-import.cjs)
// through Directus's native CSV import. Like every fixture suite it takes
// only the explicit disposable target (DIRECTUS_SEARCH_TEST_URL, _TOKEN,
// _MARKER_COLLECTION and _MARKER_VALUE: a loopback URL, a token and the
// synthetic marker, validated before any request). It never reads .env and
// has no default URL, so DIRECTUS_URL, DIRECTUS_TOKEN or
// DIRECTUS_ADMIN_TOKEN alone never point it at a project.

const missingTargetPattern = /DIRECTUS_SEARCH_TEST_URL/u;

const importedRows = z.object({
  data: z.array(z.object({ value: z.string() })),
});

test('refuses a target named only by the lifecycle variables', async () => {
  await assert.rejects(
    isolatedTarget({
      DIRECTUS_ADMIN_TOKEN: 'synthetic-token',
      DIRECTUS_TOKEN: 'synthetic-token',
      DIRECTUS_URL: 'http://127.0.0.1:18055',
    }),
    missingTargetPattern,
  );
});

test('native CSV import preserves UTF-8 across file read boundaries', async () => {
  const target = await isolatedTarget(process.env);
  const collection = `csv_utf8_test_${randomUUID().replaceAll('-', '')}`;
  const request = async (path: string, options: FetchInit = {}) => {
    const headers = new Headers(options.headers);
    headers.set('authorization', `Bearer ${target.token}`);
    const response = await fetch(new URL(path, target.base), {
      ...options,
      headers,
      signal: AbortSignal.timeout(60_000),
    });
    assert.ok(
      response.ok,
      `${options.method ?? 'GET'} ${path}: HTTP ${String(response.status)}`,
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
    const { data } = importedRows.parse(await response.json());
    assert.deepEqual(
      data.map(({ value }) => value),
      values,
      'Imported Unicode differs from the synthetic CSV',
    );
  } finally {
    await request(`/collections/${collection}`, { method: 'DELETE' });
  }
});
