type DataRow = Readonly<Record<string, unknown>>;

type ItemsService = {
  readonly readByQuery: (query: unknown) => Promise<readonly DataRow[]>;
  readonly updateBatch: (
    rows: readonly DataRow[],
    options: { readonly emitEvents: false },
  ) => Promise<unknown>;
};

type OperationContext = {
  readonly database: unknown;
  readonly getSchema: (input: {
    readonly database: unknown;
  }) => Promise<unknown>;
  readonly services: {
    readonly ItemsService: new (
      collection: string,
      options: {
        readonly accountability: null;
        readonly knex: unknown;
        readonly schema: unknown;
      },
    ) => ItemsService;
  };
};

declare const operation: {
  readonly handler: (
    options: Readonly<Record<string, never>>,
    context: OperationContext,
  ) => Promise<{
    readonly courses: number;
    readonly studentCouncilMembers: number;
  }>;
  readonly id: string;
};

export default operation;
