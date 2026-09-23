import assert from 'node:assert/strict';

import { findModelCollection } from '../../src/data-model/collections.js';
import { enumChoiceMeta } from '../../src/data-model/field-payloads.js';
import { chunk } from '../../src/migrations/batches.js';
import { collectionSpecs } from '../../src/model.js';
import { errorCode, json, read, request } from './data-model-helpers.mjs';
import { get, patch } from './history-index-helpers.mjs';

// Helpers of the declared-vocabularies scenario. Every row is invented.

const fieldPath = (collection, field) =>
  `/fields/${collection}/${encodeURIComponent(field)}`;

// The declaration of an enum field of the model.
export const declaredEnum = (collection, field) => {
  const found = findModelCollection(collection)?.fields.find(
    (candidate) => candidate.field === field,
  );
  assert.equal(found?.kind, 'enum', `${collection}.${field} is an enum`);
  return found;
};

// The live meta of a field.
export const liveMeta = async (target, collection, field) => {
  const { meta } = await get(target, fieldPath(collection, field));
  return meta;
};

// Writes an earlier vocabulary into an installed enum field, as an older
// version of this project (or a Studio user) would have left it: the
// given values, unlabelled, in the dropdown, the labels display and the
// server rule, with a Studio note and width beside them.
export const driftEnum = async (target, { collection, field, values }) => {
  const declared = declaredEnum(collection, field);
  const choices = values.map((value) => ({ text: value, value }));
  const membership = { [field]: { _in: values } };
  const meta = await liveMeta(target, collection, field);
  await patch(target, fieldPath(collection, field), {
    meta: {
      display_options: { ...meta.display_options, choices },
      note: 'Synthetic Studio note',
      options: { ...meta.options, choices },
      validation: declared.nullable
        ? { _or: [{ [field]: { _null: true } }, membership] }
        : membership,
      width: 'full',
    },
  });
};

// The code-owned choice meta of the declaration.
export const declaredChoices = (collection, field) =>
  enumChoiceMeta(declaredEnum(collection, field));

// A create the server rule refuses, answered with its error code.
export const refusedCreate = async (target, collection, item) =>
  errorCode(
    await read(
      await request(
        target,
        `/items/${collection}`,
        json('POST', item, target.token),
      ),
      400,
    ),
  );

// The workbook rows written the way the one-time import writes them:
// every checkpoint collection in model order, in batches of 250, each row
// confirmed with its id.
export const writeWorkbookRows = async (target, data) => {
  for (const spec of collectionSpecs) {
    const batches = chunk(data[spec.key], 250);
    for (const batch of batches) {
      const created = await read(
        await request(
          target,
          `/items/${spec.key}?fields=id`,
          json('POST', batch, target.token),
        ),
        200,
      );
      assert.equal(created.data.length, batch.length);
    }
  }
};

// A course row of a prepared courses.json without the key.
export const withoutKey = (rows, key) =>
  rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([name]) => name !== key)),
  );
