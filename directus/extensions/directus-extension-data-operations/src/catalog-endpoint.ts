import { defineEndpoint } from '@directus/extensions-sdk';

import type { ExportDefinition } from './exports/types.js';

import { forwardError } from './endpoint-errors.js';
import { courses } from './exports/courses.js';
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

// GET /catalog/courses.json: every course with its accreditations, staff
// and enrollment counts, built from the live data by the rules the
// collections alone do not carry. Anyone may read it: it selects only
// public fields by name. It is built at most once per cacheMs and answered
// with its digest as the ETag.

export const catalogEndpointId = 'catalog';

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

export const catalogFiles = exportDefinitions.map((definition) => ({
  build: (reader: SourceReader) => buildFile(definition, reader),
  filename: definition.filename,
}));

const cacheHeader = `public, max-age=${String(cacheMs / 1_000)}`;

export default defineEndpoint({
  handler: (router, context) => {
    let cached: undefined | { at: number; value: Promise<PreparedFile> };
    // The last file built without an error: answered while a later build
    // fails, so an edit that breaks the file never takes it away.
    let lastGood: PreparedFile | undefined;

    const build = async (): Promise<PreparedFile> => {
      try {
        lastGood = await buildFile(courses, await itemsReader(context));
        return lastGood;
      } catch (error) {
        if (lastGood === undefined) {
          cached = undefined;
          throw error;
        }
        return lastGood;
      }
    };

    router.get('/courses.json', async (request, response, next) => {
      try {
        if (cached === undefined || Date.now() - cached.at >= cacheMs) {
          cached = { at: Date.now(), value: build() };
        }
        const prepared = await cached.value;
        const etag = `"${prepared.sha256}"`;
        response.setHeader('Cache-Control', cacheHeader);
        response.setHeader('ETag', etag);
        if (request.headers['if-none-match'] === etag) {
          response.status(304).end();
          return;
        }
        response.type('application/json').send(prepared.body);
      } catch (error) {
        forwardError(next, error);
      }
    });
  },
  id: catalogEndpointId,
});
