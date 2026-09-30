import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { DirectusRequest } from '../src/directus-request.js';

import { compositeKey, planned, ref } from '../src/import/planned.js';
import { writePlan } from '../src/import/write.js';

const postedRows = z.array(z.unknown());
const options = { batchSize: 250, confirmed: () => {} };
const unresolvedReference =
  /^plan: course_curricula\.entry references curriculum_entries 2023\/kn before it is created$/u;
const duplicateKey = /^plan: duplicate curriculum_generations key 2023\/kn$/u;

// A Directus that creates every posted row with the next id.
const creating = (): DirectusRequest => {
  let next = 0;
  return async (_pathname, init) =>
    postedRows
      .parse(JSON.parse(typeof init?.body === 'string' ? init.body : '[]'))
      .map(() => {
        next += 1;
        return { id: next };
      });
};

describe('plan invariants', () => {
  test('name a composite plan key as the refusal lines show it', async () => {
    await expect(
      writePlan(
        creating(),
        [
          {
            collection: 'course_curricula',
            rows: [
              planned(compositeKey('curriculum_2023', 5), {
                entry: ref('curriculum_entries', compositeKey(2_023, 'kn')),
              }),
            ],
          },
        ],
        options,
      ),
    ).rejects.toThrow(unresolvedReference);
  });

  test('name a duplicate composite key the same way', async () => {
    const row = planned(compositeKey(2_023, 'kn'), { name: 'Synthetic' });

    await expect(
      writePlan(
        creating(),
        [{ collection: 'curriculum_generations', rows: [row, row] }],
        options,
      ),
    ).rejects.toThrow(duplicateKey);
  });
});
