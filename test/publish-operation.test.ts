import type { Readable } from 'node:stream';

import { describe, expect, test } from 'vitest';

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
});
