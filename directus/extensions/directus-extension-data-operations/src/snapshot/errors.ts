import { z } from 'zod';

export const snapshotErrorCodes = {
  ACTIVE_CHANGED: 409,
  BACKUP_FAILED: 500,
  CLAIM_BUSY: 409,
  CLAIM_LOST: 409,
  COUNT_MISMATCH: 500,
  EMPTY_NOT_CONFIRMED: 409,
  FILE_INVALID: 400,
  FINGERPRINT_MISMATCH: 409,
  FORBIDDEN: 403,
  IMPORT_FAILED: 500,
  IMPORT_RUNNING: 409,
  IMPORT_TIMEOUT: 408,
  INVALID_CSV: 400,
  INVALID_HEADERS: 400,
  INVALID_OPTIONS: 400,
  INVALID_ROWS: 400,
  NOT_READY: 409,
  PROMOTION_FAILED: 500,
  PROMOTION_RUNNING: 409,
  STAGING_CHANGED: 409,
  STAGING_GUARDED: 403,
} as const;

export type SnapshotErrorCode = keyof typeof snapshotErrorCodes;

export const maxMessageLength = 900;

export type SnapshotError = DirectusError;

// A refusal of the snapshot import or promotion, shaped like the
// DirectusError class of @directus/errors (which the bundle cannot
// import): the API error handler renders its status and code, so the
// manual Flow surfaces it to Studio and REST callers, and a reject branch
// reads it as `$last`. The message never quotes a cell value, only row
// numbers, column names and counts.
export class DirectusError extends Error {
  public readonly code: string;
  public readonly extensions: Readonly<Record<string, unknown>>;
  public override readonly name = 'DirectusError';
  public readonly reason: SnapshotErrorCode;
  public readonly status: number;

  public constructor(
    message: string,
    options: ErrorOptions & {
      readonly details?: Readonly<Record<string, unknown>>;
      readonly reason: SnapshotErrorCode;
    },
  ) {
    super(message, options);
    this.reason = options.reason;
    this.code = `SNAPSHOT_${options.reason}`;
    this.status = snapshotErrorCodes[options.reason];
    this.extensions = { reason: options.reason, ...options.details };
  }
}

export const snapshotError = (
  reason: SnapshotErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): SnapshotError =>
  new DirectusError(
    message.slice(0, maxMessageLength),
    details === undefined ? { reason } : { details, reason },
  );

export const isSnapshotError = (value: unknown): value is SnapshotError =>
  value instanceof DirectusError;

const fact = z.string().max(200).optional().catch(undefined);

// The value-free facts of a failure: its class and error code and, for a
// PostgreSQL error, the schema object it concerns. Never the message, the
// detail, the hint or the stack, which may quote a cell value.
const factsSchema = z.object({
  code: fact,
  column: fact,
  constraint: fact,
  dataType: fact,
  name: fact,
  routine: fact,
  schema: fact,
  severity: fact,
  table: fact,
});

export type FailureFacts = z.infer<typeof factsSchema>;

export const failureFacts = (error: unknown): FailureFacts => {
  const parsed = factsSchema.safeParse(error);
  return parsed.success ? parsed.data : { name: typeof error };
};

// PostgreSQL's query_canceled: a statement ran into the statement_timeout
// that IMPORT_TIMEOUT sets for every snapshot transaction (or an
// administrator cancelled it).
const cancelledCode = '57014';

// Any failure as a snapshot error: a refusal keeps its code, a cancelled
// statement is the IMPORT_TIMEOUT bound, anything else (a database or
// storage error, whose message may quote a value) is reported under the
// fallback code with its class and error code only; the operation logs
// its value-free facts (failureFacts).
export const asSnapshotError = (
  error: unknown,
  fallback: SnapshotErrorCode,
): SnapshotError => {
  if (isSnapshotError(error)) {
    return error;
  }
  const { code = 'unknown', name = typeof error } = failureFacts(error);
  if (code === cancelledCode) {
    return new DirectusError(
      'A database statement ran longer than IMPORT_TIMEOUT allows (statement_timeout) or was cancelled; nothing was changed.',
      { cause: error, reason: 'IMPORT_TIMEOUT' },
    );
  }
  return new DirectusError(
    `The run stopped on an unexpected ${name.slice(0, 60)} (code ${code.slice(0, 40)}); nothing was changed. The Directus log holds its class, code and database object.`,
    { cause: error, reason: fallback },
  );
};

// The bounded text kept in data_operations.import_error.
export const describeFailure = (error: SnapshotError): string =>
  `${error.code}: ${error.message}`.slice(0, maxMessageLength);

// The Directus logger, narrowed to the one call the snapshot runs make.
export type SnapshotLog = {
  readonly warn: (details: object, message: string) => void;
};

// Logs a failed run with the refusal's code and the value-free facts of
// what caused it.
export const logFailure = (
  log: SnapshotLog,
  run: { readonly failure: SnapshotError; readonly operation: string },
  error: unknown,
): void => {
  log.warn(
    {
      cause: failureFacts(error),
      code: run.failure.code,
      operation: run.operation,
    },
    `The Moodle snapshot ${run.operation} failed with ${run.failure.code}`,
  );
};

// Records a failure without letting a failure to record it hide the
// original one; the run's state then stays in flight until it is stale.
export const recordQuietly = async (
  log: SnapshotLog,
  work: () => Promise<unknown>,
): Promise<void> => {
  try {
    await work();
  } catch (error) {
    log.warn(
      { cause: failureFacts(error) },
      'The failure of a Moodle snapshot run could not be recorded',
    );
  }
};
