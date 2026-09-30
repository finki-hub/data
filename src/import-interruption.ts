import { errorText } from './text.js';

// How far the import got: the planned rows Directus had confirmed out of
// the plan's total.
type ImportProgress = {
  readonly confirmed: number;
  readonly total: number;
};

// The import stopped once it had started writing rows. There is no resume:
// the project holds part of the import (or, when nothing was confirmed,
// possibly nothing), so the one way to finish is a fresh project (README).
// The message is the cause on one line with the rows Directus confirmed:
// `<cause> (rows confirmed: <n>/<m>)`.
export class ImportInterruptedError extends Error {
  public override readonly name = 'ImportInterruptedError';

  public constructor(
    public readonly progress: ImportProgress,
    options: ErrorOptions,
  ) {
    super(
      `${errorText(options.cause)} (rows confirmed: ${String(progress.confirmed)}/${String(progress.total)})`,
      options,
    );
  }
}
