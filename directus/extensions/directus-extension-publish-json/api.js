import { Readable } from 'node:stream';

const contentType = 'application/json';
const reasonLength = 200;
const nameLength = 80;
// A failure names at most this many of the files published before it.
const shownFiles = 5;

// A refusal shaped like the DirectusError class of @directus/errors (which
// the extension cannot import): the API error handler renders its status
// and code, and a Flow's reject branch reads `code` and `message`.
class DirectusError extends Error {
  name = 'DirectusError';

  // options: { code, status, extensions?, cause? }; Error reads only its
  // cause.
  constructor(message, options) {
    super(message, options);
    this.code = options.code;
    this.status = options.status;
    this.extensions = { code: options.code, ...options.extensions };
  }
}

// The options refusal `Invalid options: <path>: <reason>`, the form of the
// data-operations extension's option refusals (this file is loaded as is,
// so it keeps its own copy).
const invalid = (path, reason) =>
  new DirectusError(`Invalid options: ${path}: ${reason}`, {
    code: 'PUBLISH_INVALID_OPTIONS',
    status: 400,
  });

// At most shownFiles names, then " (+N more)".
const listText = (names) =>
  names.length <= shownFiles
    ? names.join(', ')
    : `${names.slice(0, shownFiles).join(', ')} (+${names.length - shownFiles} more)`;

// Why a storage write failed, bounded: the error's name and message only.
const reasonOf = (error) => {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  return `${name}: ${message}`.slice(0, reasonLength);
};

const isObjectMap = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const jsonFilenamePattern = /^[a-z0-9][a-z0-9._-]*\.json$/u;

// The filename map's entries with their JSON bodies, every name and value
// checked before the first write.
const bodiesOf = (objects, storage) => {
  if (typeof storage !== 'string' || storage.length === 0) {
    throw invalid('storage', 'required');
  }
  if (!isObjectMap(objects)) {
    throw invalid('objects', 'expected a filename map');
  }
  const entries = Object.entries(objects);
  if (entries.length === 0) {
    throw invalid('objects', 'empty');
  }
  return entries.map(([filename, value]) => {
    if (!jsonFilenamePattern.test(filename)) {
      throw invalid(
        'objects',
        `invalid root-level JSON filename: ${filename.slice(0, nameLength)}`,
      );
    }
    const body = JSON.stringify(value);
    if (body === undefined) {
      throw invalid(`objects.${filename}`, 'not JSON serializable');
    }
    return { body, filename };
  });
};

// One file through the FilesService: an existing file of that name and
// location is replaced under its id, a new one is created.
const writeFile = async (files, { body, filename, storage }) => {
  const existing = await files.readByQuery({
    fields: ['id'],
    filter: {
      filename_disk: { _eq: filename },
      storage: { _eq: storage },
    },
    limit: 1,
  });
  await files.uploadOne(
    Readable.from([body]),
    {
      filename_disk: filename,
      filename_download: filename,
      storage,
      title: filename,
      type: contentType,
    },
    existing[0]?.id,
  );
};

const uploadFailure = (error, { filename, published, storage }) => {
  const before =
    published.length === 0 ? '' : ` (published before: ${listText(published)})`;
  return new DirectusError(
    `Upload of ${filename} to ${storage} failed${before}: ${reasonOf(error)}`,
    {
      cause: error,
      code: 'PUBLISH_UPLOAD_FAILED',
      extensions: { filename, published: [...published] },
      status: 502,
    },
  );
};

// Writes every object of the filename map, one after another, into the
// storage location. Answers the published filenames, the bytes written and
// the content type; a failed write stops the call with
// PUBLISH_UPLOAD_FAILED naming the file and what was published before it.
// Nothing is retried.
const operation = {
  handler: async ({ objects, storage }, { database, getSchema, services }) => {
    const bodies = bodiesOf(objects, storage);
    const schema = await getSchema({ database });
    const files = new services.FilesService({
      accountability: null,
      knex: database,
      schema,
    });

    const published = [];
    let bytes = 0;
    for (const { body, filename } of bodies) {
      try {
        await writeFile(files, { body, filename, storage });
      } catch (error) {
        throw uploadFailure(error, { filename, published, storage });
      }
      published.push(filename);
      bytes += Buffer.byteLength(body, 'utf8');
    }

    return { bytes, contentType, published };
  },
  id: 'finki-hub-publish-json',
};

export default operation;
