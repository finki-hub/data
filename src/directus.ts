import { z } from 'zod';

import type { DirectusConfig } from './config.js';
import type { CollectionSpec, MigrationData, MigrationItem } from './schema.js';

import { createDerivedDataFlow } from './derived-data-flow.js';
import { collectionSpecs } from './model.js';
import { createPublicAssetsFlow } from './public-assets-flow.js';

const responseSchema = z.object({ data: z.unknown() });
const collectionsSchema = z.array(z.object({ collection: z.string() }));
const itemBatchSize = 250;

type ApiField = {
  readonly field: string;
  readonly meta: {
    readonly interface: string;
    readonly readonly: boolean;
    readonly required: boolean;
    readonly sort: number;
    readonly width: 'full' | 'half';
  };
  readonly schema: { readonly is_nullable: boolean };
  readonly type: string;
};

export class DirectusRequestError extends Error {
  public override readonly name = 'DirectusRequestError';

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class ExistingCollectionError extends Error {
  public override readonly name = 'ExistingCollectionError';

  public constructor(public readonly collection: string) {
    super(
      `Collection ${collection} already exists. Import only targets a fresh Directus project.`,
    );
  }
}

const toApiField = (
  spec: CollectionSpec['fields'][number],
  index: number,
): ApiField => {
  const interfaces: Readonly<
    Record<CollectionSpec['fields'][number]['kind'], string>
  > = {
    boolean: 'boolean',
    integer: 'input',
    string: 'input',
    text: 'input-multiline',
  };

  return {
    field: spec.target,
    meta: {
      interface: interfaces[spec.kind],
      readonly: spec.derived === true,
      required: spec.required === true,
      sort: index + 1,
      width: spec.kind === 'text' ? 'full' : 'half',
    },
    schema: { is_nullable: spec.required !== true },
    type: spec.kind,
  };
};

export class DirectusClient {
  readonly #config: DirectusConfig;

  public constructor(config: DirectusConfig) {
    this.#config = config;
  }

  public async import(data: MigrationData): Promise<void> {
    const existingCollections = await this.#listCollections();
    for (const spec of collectionSpecs) {
      if (existingCollections.has(spec.key)) {
        throw new ExistingCollectionError(spec.key);
      }
    }

    for (const spec of collectionSpecs) {
      await this.#createCollection(spec);
      await this.#createPreset(spec);
      await this.#createItems(spec.key, data[spec.key]);
    }

    const request = (pathname: string, init?: Parameters<typeof fetch>[1]) =>
      this.#request(pathname, init);
    const derivedDataFlowId = await createDerivedDataFlow(request);
    await this.#request(
      `/flows/trigger/${derivedDataFlowId}`,
      {
        body: JSON.stringify({ collection: 'courses' }),
        method: 'POST',
      },
      'raw',
    );
    await createPublicAssetsFlow((pathname, init) =>
      this.#request(pathname, init),
    );
  }

  async #listCollections(): Promise<ReadonlySet<string>> {
    const collections = collectionsSchema.parse(
      await this.#request('/collections'),
    );
    return new Set(collections.map(({ collection }) => collection));
  }

  async #createCollection(spec: CollectionSpec): Promise<void> {
    await this.#request('/collections', {
      body: JSON.stringify({
        collection: spec.key,
        fields: spec.fields.map(toApiField),
        meta: {
          display_template: spec.displayTemplate,
          icon: spec.icon,
          note: spec.note,
          sort: spec.sort,
        },
        schema: {},
      }),
      method: 'POST',
    });
  }

  async #createPreset(spec: CollectionSpec): Promise<void> {
    await this.#request('/presets', {
      body: JSON.stringify({
        collection: spec.key,
        layout: 'tabular',
        layout_options: { tabular: { spacing: 'comfortable' } },
        layout_query: {
          tabular: {
            fields: spec.previewFields,
            sort: [spec.previewSort],
          },
        },
      }),
      method: 'POST',
    });
  }

  async #createItems(
    collection: string,
    items: readonly MigrationItem[],
  ): Promise<void> {
    for (let start = 0; start < items.length; start += itemBatchSize) {
      await this.#request(`/items/${collection}?fields=id`, {
        body: JSON.stringify(items.slice(start, start + itemBatchSize)),
        method: 'POST',
      });
    }
  }

  async #request(
    pathname: string,
    init?: Parameters<typeof fetch>[1],
    responseMode: 'data' | 'raw' = 'data',
  ): Promise<unknown> {
    const url = new URL(pathname, this.#config.url);
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${this.#config.token}`);
    headers.set('Content-Type', 'application/json');
    const response = await fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw new DirectusRequestError(
        `${init?.method ?? 'GET'} ${url.pathname} returned ${response.status}: ${responseText}`,
      );
    }

    if (response.status === 204) {
      return null;
    }

    const body: unknown = await response.json();
    return responseMode === 'raw' ? body : responseSchema.parse(body).data;
  }
}
