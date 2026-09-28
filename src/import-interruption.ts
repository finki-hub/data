import { YearSeedError } from './migrations/workbook-seeds.js';

const trailingPeriod = /\.$/u;

const phases = {
  converting: 'converting the rows under the migration ledger',
  writing: 'writing the workbook rows',
} as const;

export type ImportPhase = keyof typeof phases;

// Where the import stood when it stopped: its phase and the workbook rows
// Directus had confirmed out of the workbook's total.
export type ImportProgress = {
  readonly confirmed: number;
  readonly phase: ImportPhase;
  readonly total: number;
};

const refused = 'so npm run import now refuses this project';

const remedyOf = (
  { confirmed, phase, total }: ImportProgress,
  cause: unknown,
): string => {
  if (phase === 'writing' && confirmed === 0) {
    return 'Directus confirmed no workbook row, so once the cause is fixed npm run import can run again (it refuses, naming the record counts, if the failed request stored rows after all).';
  }
  if (phase === 'writing') {
    return `Directus had confirmed ${String(confirmed)} of the ${String(total)} workbook rows, ${refused}: it holds a partial import. Restore the pre-import backup or remove every application record (the empty schema may stay), then import again. Do not upgrade the partial rows with npm run migrate.`;
  }
  // npm run migrate converts the years the project holds, so it cannot
  // finish an import whose workbook years were not all seeded.
  if (cause instanceof YearSeedError) {
    return `Every workbook row was written, but not every academic year the workbook names was seeded, ${refused}, and npm run migrate would convert only the years the project holds. Restore the pre-import backup or remove every application record (the empty schema may stay), then import again.`;
  }
  return `Every workbook row was written, ${refused}. Fix the cause, then finish with npm run migrate (dry-run, then apply): its ledger resumes the interrupted conversion.`;
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
