import { isDeepStrictEqual } from 'node:util';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { CollectionSpec } from '../src/schema.js';

import { dataModelCollections } from '../src/data-model/collections.js';
import {
  baselineFieldMeta,
  presentationFieldPatches,
} from '../src/data-model/presentation/fields.js';
import { aliasesFor } from '../src/data-model/relations.js';
import { toApiField } from '../src/directus.js';
import { collectionSpecs } from '../src/model.js';
import { metaDefaults } from './data-model-test-helpers.js';
import { effectiveFieldMeta } from './presentation-test-helpers.js';

const checkpointSpecs: readonly CollectionSpec[] = collectionSpecs;

const collectionIcon = (key: string): string | undefined =>
  checkpointSpecs.find((spec) => spec.key === key)?.icon;

// The meta a checkpoint column carries on a populated deployment: written by
// the legacy importer, every other column at its Directus default.
const importerFieldMeta = (
  collection: string,
  field: string,
): Readonly<Record<string, unknown>> | undefined => {
  const spec = checkpointSpecs.find(
    (candidate) => candidate.key === collection,
  );
  const column = spec?.fields.find(({ target }) => target === field);
  if (spec === undefined || column === undefined) {
    return undefined;
  }
  return {
    ...metaDefaults,
    ...toApiField(column, spec.fields.indexOf(column)).meta,
  };
};

// Every presentation patch that targets a column the legacy importer created.
const checkpointPatches = presentationFieldPatches.flatMap((patch) => {
  const importer = importerFieldMeta(patch.collection, patch.field);
  return importer === undefined ? [] : [{ ...patch, importer }];
});

// Keys a patch writes on which the importer meta and the installer baseline
// disagree. An entry here would make the once-only rule skip that field on a
// populated deployment.
const importerDisagreements = checkpointPatches.flatMap(
  ({ collection, field, importer, meta }) => {
    const baseline = baselineFieldMeta(collection, field);
    return Object.keys(meta)
      .filter(
        (key) =>
          !isDeepStrictEqual(importer[key] ?? null, baseline[key] ?? null),
      )
      .map((key) => `${collection}.${field}.${key}`);
  },
);

const relational = z.looseObject({
  display: z.literal('related-values'),
  interface: z.string(),
  options: z.looseObject({
    enableCreate: z.boolean(),
    enableSelect: z.boolean(),
    fields: z.array(z.string()).optional(),
    template: z.string().min(1),
  }),
  readonly: z.boolean(),
});

const plain = z.looseObject({
  interface: z.string().min(1),
  readonly: z.boolean(),
});

const modelFields = dataModelCollections.flatMap((collection) =>
  collection.fields.map((field) => ({
    collection: collection.collection,
    field: field.field,
    kind: field.kind,
    readOnly: field.readOnly === true,
  })),
);

// True when every column of the collection is owned by the Flows.
const isDerived = (collection: string): boolean =>
  dataModelCollections
    .find((candidate) => candidate.collection === collection)
    ?.fields.every(({ readOnly }) => readOnly === true) === true;

const aliasMetas = dataModelCollections.flatMap((collection) =>
  aliasesFor(collection.collection).map(({ alias, relation }) => ({
    derivedTarget: isDerived(relation.collection),
    field: `${collection.collection}.${alias.field}`,
    meta: relational.parse(
      effectiveFieldMeta(collection.collection, alias.field),
    ),
    readOnly: alias.readOnly === true,
  })),
);

describe('collection icons', () => {
  test('uses the current curriculum icon for the 2018 curriculum', () => {
    expect(collectionIcon('curriculum_2018')).toBe('menu_book');
  });

  test('uses a single-person icon for Moodle users', () => {
    expect(collectionIcon('moodle_users')).toBe('person');
  });
});

describe('studio metadata', () => {
  test('gives every editable source field an interface and every relation a readable template', () => {
    expect(modelFields.length).toBeGreaterThan(0);
    expect(
      modelFields.filter(
        ({ collection, field, readOnly }) =>
          plain.parse(effectiveFieldMeta(collection, field)).readonly !==
          readOnly,
      ),
    ).toEqual([]);

    const selectors = modelFields
      .filter(({ kind }) => kind === 'm2o')
      .map(
        ({ collection, field }) =>
          relational.parse(effectiveFieldMeta(collection, field)).interface,
      );

    expect(new Set(selectors)).toEqual(new Set(['select-dropdown-m2o']));
    expect(
      aliasMetas.filter(
        ({ meta }) =>
          meta.interface !== 'list-o2m' ||
          (meta.options.fields ?? []).length === 0,
      ),
    ).toEqual([]);
  });

  test('keeps the once-only baseline equal to the legacy importer meta on every patched checkpoint column', () => {
    expect(checkpointPatches.length).toBeGreaterThan(0);
    expect(checkpointPatches.map(({ collection }) => collection)).toContain(
      'courses',
    );
    expect(importerDisagreements).toEqual([]);
  });

  test('shows derived collections as read-only rows that Studio cannot add to', () => {
    expect(
      dataModelCollections
        .filter(({ collection }) => isDerived(collection))
        .map(({ collection }) => collection),
    ).toEqual([
      'moodle_history_memberships',
      'course_enrollments',
      'data_operation_results',
      'migration_ledger',
    ]);
    expect(
      aliasMetas.filter(
        ({ derivedTarget, meta, readOnly }) =>
          readOnly !== derivedTarget ||
          meta.readonly !== derivedTarget ||
          meta.options.enableCreate === derivedTarget ||
          meta.options.enableSelect === derivedTarget,
      ),
    ).toEqual([]);
  });
});
