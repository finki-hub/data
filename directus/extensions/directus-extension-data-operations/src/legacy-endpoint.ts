import { defineEndpoint } from '@directus/extensions-sdk';

import type { ExportDefinition } from './exports/types.js';

import { errorBody, forwardError } from './endpoint-errors.js';
import { itemsReader } from './exports/directus.js';
import {
  readFileSources,
  serializeFile,
  type SourceReader,
} from './exports/engine.js';
import {
  fileShape,
  type PreparedFile,
  validateFile,
} from './exports/file-check.js';
import { exportDefinitions } from './exports/index.js';

// GET /legacy/<file>: the public JSON files the consumers read from the old
// assets bucket (courses.json, rooms.json, staff.json), in exactly that
// format, built from the live data. Anyone may read them, like the public
// API: every definition reads its public fields by name, so no private
// column is ever selected. A file is built at most once per cacheMs and
// answered with its digest as the ETag.

export const legacyEndpointId = 'legacy';

export const cacheMs = 60_000;

// One file from the live data, validated against its definition.
export const buildFile = async (
  definition: ExportDefinition,
  reader: SourceReader,
): Promise<PreparedFile> => {
  const sources = await readFileSources(definition, reader);
  return validateFile(
    definition,
    serializeFile(definition, sources),
    fileShape(definition, sources),
  );
};

export const findDefinition = (filename: string) =>
  exportDefinitions.find((definition) => definition.filename === filename);

type Cached = { readonly at: number; readonly file: Promise<PreparedFile> };

export default defineEndpoint({
  handler: (router, context) => {
    const cache = new Map<string, Cached>();
    // The last file built without an error: answered while a later build
    // fails, so an edit that breaks a file never takes it away from the
    // consumers.
    const lastGood = new Map<string, PreparedFile>();
    const build = async (
      definition: ExportDefinition,
    ): Promise<PreparedFile> => {
      try {
        const file = await buildFile(definition, await itemsReader(context));
        lastGood.set(definition.filename, file);
        return file;
      } catch (error) {
        const previous = lastGood.get(definition.filename);
        if (previous === undefined) {
          throw error;
        }
        return previous;
      }
    };
    const fileOf = (definition: ExportDefinition): Promise<PreparedFile> => {
      const hit = cache.get(definition.filename);
      if (hit !== undefined && Date.now() - hit.at < cacheMs) {
        return hit.file;
      }
      const file = build(definition);
      cache.set(definition.filename, { at: Date.now(), file });
      // A failed build is not cached: the next request builds again.
      void (async () => {
        try {
          await file;
        } catch {
          cache.delete(definition.filename);
        }
      })();
      return file;
    };

    router.get('/:filename', async (request, response, next) => {
      const definition = findDefinition(request.params.filename);
      if (definition === undefined) {
        response
          .status(404)
          .json(errorBody('ROUTE_NOT_FOUND', 'No such legacy file'));
        return;
      }
      try {
        const file = await fileOf(definition);
        const etag = `"${file.sha256}"`;
        response.setHeader(
          'Cache-Control',
          `public, max-age=${String(cacheMs / 1_000)}`,
        );
        response.setHeader('ETag', etag);
        if (request.headers['if-none-match'] === etag) {
          response.status(304).end();
          return;
        }
        response.type('application/json').send(file.body);
      } catch (error) {
        forwardError(next, error);
      }
    });
  },
  id: legacyEndpointId,
});
