import { describe, expect, test } from 'vitest';

import { committed, committedFiles, expectedSums } from './expected-exports.js';

const collator = new Intl.Collator('en');

describe('the committed expected exports', () => {
  test('hold exactly the files SHA256SUMS lists, each with its listed sha256', async () => {
    const listed = expectedSums
      .keys()
      .toArray()
      .toSorted((left, right) => collator.compare(left, right));

    await expect(committedFiles()).resolves.toEqual(listed);

    for (const file of listed) {
      await expect(committed(file)).resolves.toEqual(expect.any(String));
    }
  });

  test('refuse a file that SHA256SUMS does not list', async () => {
    await expect(committed('SHA256SUMS')).rejects.toThrow(
      'SHA256SUMS does not match SHA256SUMS',
    );
  });
});
