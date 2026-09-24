import type { Readable } from 'node:stream';

type FileMetadata = {
  readonly filename_disk: string;
  readonly filename_download: string;
  readonly storage: string;
  readonly title: string;
  readonly type: string;
};

type FilesService = {
  readonly readByQuery: (
    query: unknown,
  ) => Promise<ReadonlyArray<{ readonly id: unknown }>>;
  readonly uploadOne: (
    stream: Readable,
    metadata: FileMetadata,
    primaryKey?: unknown,
  ) => Promise<unknown>;
};

type PublishContext = {
  readonly database: unknown;
  readonly getSchema: (input: {
    readonly database: unknown;
  }) => Promise<unknown>;
  readonly services: {
    readonly FilesService: new (options: {
      readonly accountability: null;
      readonly knex: unknown;
      readonly schema: unknown;
    }) => FilesService;
  };
};

type PublishOptions = {
  readonly objects: Readonly<Record<string, unknown>>;
  readonly storage: string;
};

// What one call answers: the filenames written, in order, the UTF-8 bytes
// of their bodies and the content type they were stored with. A refusal
// is a DirectusError-shaped error with `code` PUBLISH_INVALID_OPTIONS
// (400) or PUBLISH_UPLOAD_FAILED (502, `extensions.filename` and
// `extensions.published`).
type PublishResult = {
  readonly bytes: number;
  readonly contentType: string;
  readonly published: readonly string[];
};

declare const operation: {
  readonly handler: (
    options: PublishOptions,
    context: PublishContext,
  ) => Promise<PublishResult>;
  readonly id: string;
};

export default operation;
