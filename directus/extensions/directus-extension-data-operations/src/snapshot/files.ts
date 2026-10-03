import type { OperationContext } from '@directus/types';

import { Readable } from 'node:stream';
import { z } from 'zod';

import type { SqlClient } from '../coordination/sql-port.js';
import type { FileFacts, SnapshotFiles } from './port.js';

import { sqlDatabase } from '../coordinate.js';
import { snapshotFolderId } from './contract.js';
import { fileSql } from './sql.js';

const text = z.string().nullable();

const fileRows = z.object({
  rows: z.array(
    z.object({
      filename_download: text,
      filesize: z.coerce.number().nullable(),
      folder: text,
      id: z.string(),
      storage: z.string(),
      type: text,
    }),
  ),
});

// The private CSV as directus_files describes it, or null without a row.
const describeFile = async (
  client: SqlClient,
  id: string,
): Promise<FileFacts | null> => {
  const [file] = fileRows.parse(await client.raw(fileSql, [id])).rows;
  return file === undefined
    ? null
    : {
        filename: file.filename_download,
        folder: file.folder,
        id: file.id,
        size: file.filesize,
        storage: file.storage,
        type: file.type,
      };
};

// The Directus services the snapshot operations use, as system services
// (accountability null): the operations check the caller themselves
// (access.ts) before anything else, and the files they touch are private
// ones in the snapshot folder. A backup is a new file in that
// folder of the local storage location, never the publish location.
export const snapshotFiles = async (
  context: OperationContext,
): Promise<SnapshotFiles> => {
  const schema = await context.getSchema();
  const options = { accountability: null, knex: context.database, schema };
  const assets = new context.services.AssetsService(options);
  const files = new context.services.FilesService(options);
  const sql = sqlDatabase(context.database);
  return {
    describe: (id) => describeFile(sql, id),
    open: async (id) => {
      const { stream } = await assets.getAsset(id);
      return stream;
    },
    upload: async (content, title) =>
      String(
        await files.uploadOne(
          Readable.from(content),
          {
            filename_download: title,
            folder: snapshotFolderId,
            storage: 'local',
            title,
            type: 'text/csv',
          },
          undefined,
          { emitEvents: false },
        ),
      ),
  };
};
