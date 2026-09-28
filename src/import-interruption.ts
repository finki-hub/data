const trailingPeriod = /\.$/u;

// How far the import got: the planned rows Directus had confirmed out of
// the plan's total.
type ImportProgress = {
  readonly confirmed: number;
  readonly total: number;
};

// The import stopped once it had started writing rows. There is no resume:
// the project holds part of the import (or, when nothing was confirmed,
// possibly nothing), so the one way to finish is a fresh project.
export class ImportInterruptedError extends Error {
  public override readonly name = 'ImportInterruptedError';

  public constructor(
    public readonly progress: ImportProgress,
    options: ErrorOptions,
  ) {
    const cause =
      options.cause instanceof Error
        ? options.cause.message
        : String(options.cause);
    super(
      `The import stopped while writing the relational rows: ${cause.replace(trailingPeriod, '')}. Directus had confirmed ${String(progress.confirmed)} of the ${String(progress.total)} planned rows. Set up a fresh project and import again.`,
      options,
    );
  }
}
