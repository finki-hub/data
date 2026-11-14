import { defineEndpoint } from '@directus/extensions-sdk';
import { z } from 'zod';

import type { ExportDefinition } from './exports/types.js';

import { errorBody, forwardError } from './endpoint-errors.js';
import { itemsReader } from './exports/directus.js';
import {
  readFileSources,
  rowsOf,
  serializeFile,
  type SourceReader,
} from './exports/engine.js';
import {
  fileShape,
  type PreparedFile,
  validateFile,
} from './exports/file-check.js';
import { exportDefinitions } from './exports/index.js';
import {
  buildPlainFile,
  examSessions,
  plainFiles,
  type SessionFile,
  sessionFiles,
} from './exports/plain-files.js';

// GET /legacy/<file>: the public JSON files the consumers read from the old
// assets bucket (anto.json, courses.json, rooms.json, sessions.json,
// staff.json), in exactly that format, built from the live data, and
// GET /legacy/sessions/<file name>: the schedule file a session of
// sessions.json names. Anyone may read them, like the public API: every
// file reads its public fields by name, so no private column is ever
// selected, and only the files the exam sessions link are served. A file
// is built at most once per cacheMs and answered with its digest as the
// ETag.

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

type LegacyFile = {
  readonly build: (reader: SourceReader) => Promise<PreparedFile>;
  readonly filename: string;
};

export const legacyFiles: readonly LegacyFile[] = [
  ...exportDefinitions.map((definition) => ({
    build: (reader: SourceReader) => buildFile(definition, reader),
    filename: definition.filename,
  })),
  ...plainFiles.map((file) => ({
    build: (reader: SourceReader) => buildPlainFile(file, reader),
    filename: file.filename,
  })),
];

export const findLegacyFile = (filename: string) =>
  legacyFiles.find((file) => file.filename === filename);

// The stored metadata of a schedule file the response needs.
const assetFile = z.object({
  filesize: z.coerce.number().nullable(),
  type: z.string().nullable(),
});

// A value per key, computed at most once per cacheMs; a failed
// computation is not kept, so the next request computes it again.
const cachedValues = <T>() => {
  const cache = new Map<string, { at: number; value: Promise<T> }>();
  return (key: string, compute: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key);
    if (hit !== undefined && Date.now() - hit.at < cacheMs) {
      return hit.value;
    }
    const value = compute();
    cache.set(key, { at: Date.now(), value });
    void (async () => {
      try {
        await value;
      } catch {
        cache.delete(key);
      }
    })();
    return value;
  };
};

const cacheHeader = `public, max-age=${String(cacheMs / 1_000)}`;

export default defineEndpoint({
  handler: (router, context) => {
    const files = cachedValues<PreparedFile>();
    const schedules = cachedValues<ReadonlyMap<string, SessionFile>>();
    // The last file built without an error: answered while a later build
    // fails, so an edit that breaks a file never takes it away from the
    // consumers.
    const lastGood = new Map<string, PreparedFile>();
    const build = async (file: LegacyFile): Promise<PreparedFile> => {
      try {
        const built = await file.build(await itemsReader(context));
        lastGood.set(file.filename, built);
        return built;
      } catch (error) {
        const previous = lastGood.get(file.filename);
        if (previous === undefined) {
          throw error;
        }
        return previous;
      }
    };
    const readSchedules = async () => {
      const reader = await itemsReader(context);
      return sessionFiles(
        rowsOf('sessions read rows', await reader(examSessions.read)),
      );
    };

    router.get('/sessions/:filename', async (request, response, next) => {
      try {
        const byName = await schedules('all', readSchedules);
        const schedule = byName.get(request.params.filename);
        if (schedule === undefined) {
          response
            .status(404)
            .json(errorBody('ROUTE_NOT_FOUND', 'No such session file'));
          return;
        }
        // Streamed from whichever storage location holds the file.
        const assets = new context.services.AssetsService({
          accountability: null,
          knex: context.database,
          schema: await context.getSchema({ database: context.database }),
        });
        const asset = await assets.getAsset(schedule.id);
        const { filesize, type } = assetFile.parse(asset.file);
        response.setHeader('Cache-Control', cacheHeader);
        response.type(type ?? 'application/octet-stream');
        if (filesize !== null) {
          response.setHeader('Content-Length', String(filesize));
        }
        asset.stream.on('error', () => response.destroy());
        asset.stream.pipe(response);
      } catch (error) {
        forwardError(next, error);
      }
    });

    router.get('/:filename', async (request, response, next) => {
      const file = findLegacyFile(request.params.filename);
      if (file === undefined) {
        response
          .status(404)
          .json(errorBody('ROUTE_NOT_FOUND', 'No such legacy file'));
        return;
      }
      try {
        const prepared = await files(file.filename, () => build(file));
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
  id: legacyEndpointId,
});
