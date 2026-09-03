import { Readable } from 'node:stream';

class InvalidPublishOptionsError extends Error {
  name = 'InvalidPublishOptionsError';
}

const isObjectMap = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const jsonFilenamePattern = /^[a-z0-9][a-z0-9._-]*\.json$/u;

const operation = {
  handler: async ({ objects, storage }, { database, getSchema, services }) => {
    if (typeof storage !== 'string' || storage.length === 0) {
      throw new InvalidPublishOptionsError('Storage location is required');
    }

    if (!isObjectMap(objects)) {
      throw new InvalidPublishOptionsError('Objects must be a filename map');
    }

    const entries = Object.entries(objects);
    if (entries.length === 0) {
      throw new InvalidPublishOptionsError('At least one object is required');
    }

    const schema = await getSchema({ database });
    const files = new services.FilesService({
      accountability: null,
      knex: database,
      schema,
    });

    for (const [filename, value] of entries) {
      if (!jsonFilenamePattern.test(filename)) {
        throw new InvalidPublishOptionsError(
          `Invalid root-level JSON filename: ${filename}`,
        );
      }

      const body = JSON.stringify(value);
      if (body === undefined) {
        throw new InvalidPublishOptionsError(
          `Value for ${filename} is not JSON serializable`,
        );
      }

      const existing = await files.readByQuery({
        fields: ['id'],
        filter: {
          filename_disk: { _eq: filename },
          storage: { _eq: storage },
        },
        limit: 1,
      });
      const primaryKey = existing[0]?.id;

      await files.uploadOne(
        Readable.from([body]),
        {
          filename_disk: filename,
          filename_download: filename,
          storage,
          title: filename,
          type: 'application/json',
        },
        primaryKey,
      );
    }

    return { published: entries.map(([filename]) => filename) };
  },
  id: 'finki-hub-publish-json',
};

export default operation;
