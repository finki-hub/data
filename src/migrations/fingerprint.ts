import { createHash } from 'node:crypto';

import type { Inventory } from './inventory.js';

// Bumped whenever the inventoried payload changes shape: version 2 added the
// curriculum and course value columns the converters copy and the column
// list of every checkpoint collection.
export const fingerprintVersion = 2;

const collator = new Intl.Collator('en');

// JSON with object keys sorted at every depth, so equal data hashes equally
// whatever order Directus returned the columns in.
export const canonicalJson = (value: unknown): string => {
  if (value === undefined || value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .toSorted(([left], [right]) => collator.compare(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
};

// sha256 over the inventoried source: every checkpoint row with exactly the
// columns the inventory reads, sorted by id, the column list of every
// checkpoint collection, plus every persisted Flow and operation. Target
// rows are excluded on purpose: converters write them during a run and the
// recorded fingerprint must survive that.
export const fingerprintInventory = (inventory: Inventory): string =>
  createHash('sha256')
    .update(
      canonicalJson({
        checkpoint: inventory.checkpoint,
        fields: inventory.fields,
        flows: inventory.flows,
        operations: inventory.operations,
        version: fingerprintVersion,
      }),
    )
    .digest('hex');
