import type { WorkbookConversion } from './migrations/workbook-adapter.js';

import { YearSeedError } from './migrations/workbook-seeds.js';

const trailingPeriod = /\.$/u;

const phases = {
  converting: 'converting the rows under the migration ledger',
  rebuilding: 'running the initial derived-data rebuild',
  writing: 'writing the workbook rows',
} as const;

export type ImportPhase = keyof typeof phases;

// Where the import stood when it stopped: its phase, the workbook rows
// Directus had confirmed out of the workbook's total, and the outcome of
// the relational conversion once it ran.
export type ImportProgress = {
  readonly confirmed: number;
  readonly conversion: null | WorkbookConversion;
  readonly phase: ImportPhase;
  readonly total: number;
};

// The Publish Flow is installed before the first row is written, so every
// interruption leaves it active over rows that are incomplete or whose
// derived columns were never rebuilt.
const noPublish =
  'Do not run Publish public assets before Rebuild derived data has run over the complete rows.';

const refused = 'so npm run import now refuses this project';

const remedyOf = (
  { confirmed, conversion, phase, total }: ImportProgress,
  cause: unknown,
): string => {
  if (phase === 'writing' && confirmed === 0) {
    return `Directus confirmed no workbook row, so once the cause is fixed npm run import can run again (it refuses, naming the record counts, if the failed request stored rows after all). ${noPublish}`;
  }
  if (phase === 'writing') {
    return `Directus had confirmed ${String(confirmed)} of the ${String(total)} workbook rows, ${refused}: it holds a partial import. Restore the pre-import backup or remove every application record (the empty schema may stay), then import again. Do not upgrade the partial rows with npm run migrate. ${noPublish}`;
  }
  // npm run migrate converts the years the project holds, so it cannot
  // finish an import whose workbook years were not all seeded.
  if (phase === 'converting' && cause instanceof YearSeedError) {
    return `Every workbook row was written, but not every academic year the workbook names was seeded, ${refused}, and npm run migrate would convert only the years the project holds. Restore the pre-import backup or remove every application record (the empty schema may stay), then import again. ${noPublish}`;
  }
  if (phase === 'converting') {
    return `Every workbook row was written, ${refused}. Fix the cause, then finish with npm run migrate (dry-run, then apply): its ledger resumes the interrupted conversion. The initial rebuild did not run, so run Rebuild derived data from Studio once the upgrade is done. ${noPublish}`;
  }
  if (conversion?.status === 'blocked') {
    return `The rows are imported, but the relational conversion is blocked by ${JSON.stringify(conversion.blockers)} and did not run, ${refused}. Run Rebuild derived data from Studio, resolve those findings in Studio, then finish with npm run migrate (dry-run, then apply). ${noPublish}`;
  }
  return `The rows and the relational conversion are complete, ${refused}. Run Rebuild derived data from Studio instead of importing again. ${noPublish}`;
};

// The import stopped once it had started writing rows. The message names
// the phase, whether any row was stored, and the one way to finish from
// that state.
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
      `The import stopped while ${phases[progress.phase]}: ${cause.replace(trailingPeriod, '')}. ${remedyOf(progress, options.cause)}`,
      options,
    );
  }
}
