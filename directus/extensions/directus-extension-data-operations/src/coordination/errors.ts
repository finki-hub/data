import { z } from 'zod';

export type CoordinationError = DirectusError;

type CoordinationErrorCode =
  | 'CLAIM_MISMATCH'
  | 'COMPLETION_RACED'
  | 'DOMAIN_MISMATCH'
  | 'DUPLICATE_ROWS'
  | 'FINGERPRINT_CHANGED'
  | 'INVALID_OPTIONS'
  | 'OUTCOMES_INCOMPLETE'
  | 'OWNER_MISMATCH'
  | 'PAGE_INCOMPLETE'
  | 'PAGE_OVER_BUDGET'
  | 'PAGE_UNPLANNED'
  | 'PAGES_MISSING'
  | 'SOURCE_CHANGED'
  | 'UNKNOWN_FILE'
  | 'UNKNOWN_RULE_MODE'
  | 'WRITE_GUARDED';

type CoordinationErrorOptions = ErrorOptions & {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly reason: CoordinationErrorCode;
  readonly status?: number;
};

// A refusal of the coordinator, shaped like the DirectusError class of
// @directus/errors (which the bundle cannot import): the API error handler
// recognises the name and renders the status and code, so a manual Flow
// with error_on_reject surfaces the refusal to its caller as a 409 or 400
// instead of a masked 500, and a reject branch receives the same code.
export class DirectusError extends Error {
  public readonly code: string;
  public readonly extensions: Readonly<Record<string, unknown>>;
  public override readonly name = 'DirectusError';
  public readonly reason: CoordinationErrorCode;
  public readonly status: number;

  public constructor(message: string, options: CoordinationErrorOptions) {
    super(message, options);
    this.reason = options.reason;
    this.code = `COORDINATION_${options.reason}`;
    this.status = options.status ?? 409;
    this.extensions = { reason: options.reason, ...options.details };
  }
}

export const coordinationError = (
  reason: CoordinationErrorCode,
  message: string,
  options: Omit<CoordinationErrorOptions, 'reason'> = {},
): CoordinationError => new DirectusError(message, { ...options, reason });

export const isCoordinationError = (
  value: unknown,
): value is CoordinationError => value instanceof DirectusError;

// PostgreSQL's lock_not_available (SQLSTATE 55P03): a bounded lock wait
// (limitLockWait) ended before the lock was granted.
const lockNotAvailable = z.object({ code: z.literal('55P03') });

export const isLockUnavailable = (error: unknown): boolean =>
  lockNotAvailable.safeParse(error).success;
