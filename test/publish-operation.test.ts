import type { Readable } from 'node:stream';

import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import operation from '../directus/extensions/directus-extension-publish-json/api.js';

type Upload = {
  readonly body: string;
  readonly metadata: {
    readonly filename_disk: string;
    readonly filename_download: string;
    readonly storage: string;
    readonly title: string;
    readonly type: string;
  };
  readonly primaryKey: unknown;
};

const storage = 'publish';

const lookup = z.object({
  filter: z.object({ filename_disk: z.object({ _eq: z.string() }) }),
});

// A storage refusal as the S3 client raises it.
class InternalError extends Error {
  public override readonly name = 'InternalError';
}

// A FilesService that records every upload attempt and refuses the named
// file, with a long cause.
const filesService = (attempts: string[], refused: null | string) =>
  class {
    readonly #attempts = attempts;

    // A file is found once an earlier upload of this fake stored it.
    public async readByQuery(
      query: unknown,
    ): Promise<ReadonlyArray<{ readonly id: string }>> {
      const name = lookup.parse(query).filter.filename_disk._eq;
      return this.#attempts.includes(name) ? [{ id: name }] : [];
    }

    public async uploadOne(
      _stream: Readable,
      metadata: Upload['metadata'],
    ): Promise<string> {
      if (metadata.filename_disk === refused) {
        this.#attempts.push(`failed:${metadata.filename_disk}`);
        throw new InternalError(
          `We encountered an internal error. ${'x'.repeat(900)}`,
        );
      }
      this.#attempts.push(metadata.filename_disk);
      return metadata.filename_disk;
    }
  };

const refusalShape = z.object({
  code: z.string(),
  extensions: z.record(z.string(), z.unknown()),
  message: z.string(),
  name: z.string(),
  status: z.number(),
});

const failureOf = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
    return null;
  } catch (error) {
    return error;
  }
};

describe('Publish JSON operation', () => {
  test('writes new and existing objects with stable filenames', async () => {
    const uploads: Upload[] = [];
    const courseFilename = 'courses.json';
    const roomFilename = 'rooms.json';
    const existingFilename = roomFilename;

    class FakeFilesService {
      readonly #existingFilename = existingFilename;
      readonly #uploads = uploads;

      public async readByQuery(
        query: unknown,
      ): Promise<ReadonlyArray<{ readonly id: string }>> {
        if (
          typeof query === 'object' &&
          query !== null &&
          'filter' in query &&
          typeof query.filter === 'object' &&
          query.filter !== null &&
          'filename_disk' in query.filter &&
          typeof query.filter.filename_disk === 'object' &&
          query.filter.filename_disk !== null &&
          '_eq' in query.filter.filename_disk &&
          query.filter.filename_disk._eq === this.#existingFilename
        ) {
          return [{ id: 'existing-file' }];
        }

        return [];
      }

      public async uploadOne(
        stream: Readable,
        metadata: Upload['metadata'],
        primaryKey?: unknown,
      ): Promise<void> {
        const chunks: Uint8Array[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.from(String(chunk)));
        }

        this.#uploads.push({
          body: Buffer.concat(chunks).toString('utf8'),
          metadata,
          primaryKey,
        });
      }
    }

    const result = await operation.handler(
      {
        objects: {
          [courseFilename]: [{ name: 'Algorithms' }],
          [roomFilename]: [{ name: '117' }],
        },
        storage: 'publish',
      },
      {
        database: {},
        getSchema: async () => ({}),
        services: { FilesService: FakeFilesService },
      },
    );

    expect(result).toEqual({
      bytes:
        Buffer.byteLength('[{"name":"Algorithms"}]') +
        Buffer.byteLength('[{"name":"117"}]'),
      contentType: 'application/json',
      published: [courseFilename, roomFilename],
    });
    expect(uploads).toEqual([
      {
        body: '[{"name":"Algorithms"}]',
        metadata: {
          filename_disk: courseFilename,
          filename_download: courseFilename,
          storage: 'publish',
          title: courseFilename,
          type: 'application/json',
        },
        primaryKey: undefined,
      },
      {
        body: '[{"name":"117"}]',
        metadata: {
          filename_disk: roomFilename,
          filename_download: roomFilename,
          storage: 'publish',
          title: roomFilename,
          type: 'application/json',
        },
        primaryKey: 'existing-file',
      },
    ]);
  });

  test('answers one file per call with its bytes, as the publish loop calls it', async () => {
    const context = {
      database: {},
      getSchema: async () => ({}),
      services: { FilesService: filesService([], null) },
    };
    const rooms = [{ name: 'Синтетичка сала' }];

    await expect(
      operation.handler({ objects: { 'rooms.json': rooms }, storage }, context),
    ).resolves.toEqual({
      bytes: Buffer.byteLength(JSON.stringify(rooms), 'utf8'),
      contentType: 'application/json',
      published: ['rooms.json'],
    });
  });

  test('refuses invalid options with a bounded code', async () => {
    const context = {
      database: {},
      getSchema: async () => ({}),
      services: { FilesService: filesService([], null) },
    };

    for (const options of [
      { objects: {}, storage },
      { objects: { '../x.json': [] }, storage },
      { objects: { 'a.json': [] }, storage: '' },
    ]) {
      await expect(operation.handler(options, context)).rejects.toMatchObject({
        code: 'PUBLISH_INVALID_OPTIONS',
        name: 'DirectusError',
        status: 400,
      });
    }
  });

  test('reports a storage failure with a bounded code, naming what it had published, and retries nothing', async () => {
    const uploaded: string[] = [];
    const context = {
      database: {},
      getSchema: async () => ({}),
      services: { FilesService: filesService(uploaded, 'rooms.json') },
    };
    const refusal = await failureOf(
      operation.handler(
        {
          objects: { 'courses.json': [], 'rooms.json': [], 'staff.json': [] },
          storage,
        },
        context,
      ),
    );
    const parsed = refusalShape.parse(refusal);

    expect(parsed).toMatchObject({
      code: 'PUBLISH_UPLOAD_FAILED',
      extensions: { filename: 'rooms.json', published: ['courses.json'] },
      name: 'DirectusError',
      status: 502,
    });
    expect(parsed.message).toContain(
      'Uploading rooms.json to storage publish failed after courses.json: InternalError: We encountered an internal error.',
    );
    expect(parsed.message.length).toBeLessThanOrEqual(400);
    // Nothing after the failure, and no second attempt of it.
    expect(uploaded).toEqual(['courses.json', 'failed:rooms.json']);
  });
});
