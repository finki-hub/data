import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

test('native CSV import preserves UTF-8 across file read boundaries', async () => {
  const base = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
  const token = process.env.DIRECTUS_TOKEN ?? process.env.DIRECTUS_ADMIN_TOKEN;
  assert.ok(token, 'Set DIRECTUS_TOKEN or DIRECTUS_ADMIN_TOKEN');
  const collection = `csv_utf8_test_${randomUUID().replaceAll('-', '')}`;
  const request = async (path, options = {}) => {
    const response = await fetch(new URL(path, base), {
      ...options,
      headers: { authorization: `Bearer ${token}`, ...options.headers },
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
