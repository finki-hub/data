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

declare const operation: {
  readonly handler: (
    options: PublishOptions,
    context: PublishContext,
  ) => Promise<{ readonly published: readonly string[] }>;
  readonly id: string;
};

export default operation;
