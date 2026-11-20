import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import {
  dataModelCollectionKeys,
  dataModelCollections,
} from '../src/data-model/collections.js';
import {
  CollectionLimitError,
  installDataModel,
} from '../src/data-model/install.js';
import { aliasesFor, modelRelations } from '../src/data-model/relations.js';
import { DirectusRequestError } from '../src/directus-request.js';
import {
  emptyState,
  fakeDirectus,
  installedState,
  mutations,
} from './data-model-test-helpers.js';

const failureOf = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
    return null;
  } catch (error) {
    return error;
  }
};

const totalFields = dataModelCollections.reduce(
  (sum, collection) =>
    sum + collection.fields.length + aliasesFor(collection.collection).length,
  0,
);

const limitError = new DirectusRequestError(
  'POST /collections: HTTP 403 LIMIT_EXCEEDED',
  {
    code: 'LIMIT_EXCEEDED',
    reason: null,
    status: 403,
  },
);

const collectionBody = z.object({
  collection: z.string(),
  fields: z.array(
    z.object({
      field: z.string(),
      meta: z.looseObject({ special: z.array(z.string()).optional() }),
      type: z.string(),
    }),
  ),
  meta: z.looseObject({ hidden: z.boolean(), singleton: z.boolean() }),
  schema: z.object({}),
});

const relationBody = z.object({
  collection: z.string(),
  field: z.string(),
  meta: z.object({ one_field: z.string().nullable() }),
  related_collection: z.string(),
  schema: z.object({ on_delete: z.enum(['CASCADE', 'NO ACTION', 'SET NULL']) }),
});

describe('installDataModel on fresh and installed projects', () => {
  test('creates every collection schema-only and then every relation on a fresh project', async () => {
    const { request, requests } = fakeDirectus(emptyState());

    const summary = await installDataModel(request);

    expect(summary).toEqual({
      collections: {
        created: dataModelCollectionKeys.length,
        refused: 0,
        skipped: 0,
      },
      fields: {
        adopted: 0,
        aligned: 0,
        created: totalFields,
        refused: 0,
        skipped: 0,
      },
      relations: {
        adopted: 0,
        created: modelRelations.length,
        refused: 0,
        skipped: 0,
      },
    });

    const changes = mutations(requests);

    expect(changes.every(({ method }) => method === 'POST')).toBeTruthy();
    expect(changes.some(({ pathname }) => pathname.startsWith('/items'))).toBe(
      false,
    );

    const collections = changes.slice(0, dataModelCollectionKeys.length);

    expect(collections.map(({ pathname }) => pathname)).toEqual(
      dataModelCollectionKeys.map(() => '/collections'),
    );
    expect(
      collections.map(({ body }) => collectionBody.parse(body).collection),
    ).toEqual(dataModelCollectionKeys);

    const relations = changes.slice(dataModelCollectionKeys.length);

    expect(relations.map(({ pathname }) => pathname)).toEqual(
      modelRelations.map(() => '/relations'),
    );

    const created = new Set(
      collections.map(({ body }) => collectionBody.parse(body).collection),
    );
    const dangling = relations
      .map(({ body }) => relationBody.parse(body))
      .filter(
        ({ collection, related_collection }) =>
          !created.has(collection) ||
          (!created.has(related_collection) &&
            related_collection !== 'directus_files'),
      );

    expect(dangling).toEqual([]);
  });

  test('declares aliases, singleton and hidden metadata inline in the collection payload', async () => {
    const { request, requests } = fakeDirectus(emptyState());

    await installDataModel(request);

    const bodies = mutations(requests).flatMap(({ body, pathname }) =>
      pathname === '/collections' ? [collectionBody.parse(body)] : [],
    );
    const courses = bodies.find(({ collection }) => collection === 'courses');

    expect(
      courses?.fields
        .filter(({ type }) => type === 'alias')
        .map(({ field, meta }) => ({ field, special: meta.special })),
    ).toEqual(
      aliasesFor('courses').map(({ alias }) => ({
        field: alias.field,
        special: [alias.junction === undefined ? 'o2m' : 'm2m'],
      })),
    );
    expect(courses?.fields.some(({ field }) => field === 'id')).toBe(false);

    const operations = bodies.find(
      ({ collection }) => collection === 'data_operations',
    );

    expect(operations?.meta).toMatchObject({ hidden: true, singleton: true });
    expect(operations?.schema).toEqual({});
  });

  test('issues no mutating call on an already installed project', async () => {
    const { request, requests } = fakeDirectus(installedState());

    const summary = await installDataModel(request);

    expect(mutations(requests)).toEqual([]);
    expect(summary).toEqual({
      collections: {
        created: 0,
        refused: 0,
        skipped: dataModelCollectionKeys.length,
      },
      fields: {
        adopted: 0,
        aligned: 0,
        created: 0,
        refused: 0,
        skipped: totalFields,
      },
      relations: {
        adopted: 0,
        created: 0,
        refused: 0,
        skipped: modelRelations.length,
      },
    });
    expect(requests.filter(({ method }) => method === 'GET')).toHaveLength(
      1 + dataModelCollectionKeys.length * 2,
    );
  });

  test('turns the licence cap into a refusal naming the collection', async () => {
    const { request, requests } = fakeDirectus(
      emptyState(),
      new Map([['POST /collections', limitError]]),
    );

    const failure = await failureOf(installDataModel(request));

    expect(failure).toBeInstanceOf(CollectionLimitError);
    expect(failure instanceof Error && failure.message).toBe(
      `collection courses not created: licence collection limit (LIMIT_EXCEEDED); model collections: ${String(dataModelCollectionKeys.length)}`,
    );
    expect(failure instanceof CollectionLimitError && failure.collection).toBe(
      'courses',
    );
    expect(mutations(requests)).toHaveLength(1);
  });

  test('rethrows other request failures untouched', async () => {
    const outage = new DirectusRequestError(
      'POST /collections: HTTP 500 INTERNAL_SERVER_ERROR',
      {
        code: 'INTERNAL_SERVER_ERROR',
        reason: null,
        status: 500,
      },
    );
    const { request } = fakeDirectus(
      emptyState(),
      new Map([['POST /collections', outage]]),
    );

    await expect(installDataModel(request)).rejects.toBe(outage);
  });
});
