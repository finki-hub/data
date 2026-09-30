const exportErrorCodes = {
  FORBIDDEN: 403,
  INVALID_DEFINITION: 500,
  INVALID_OPTIONS: 400,
  INVALID_PAYLOAD: 500,
  INVALID_READ: 500,
  NOT_READY: 409,
  UNRESOLVED: 409,
  UNSTABLE_PREPARATION: 409,
} as const;

type ExportErrorCode = keyof typeof exportErrorCodes;

const maxExportMessageLength = 600;

type ExportError = DirectusError;

// A refusal of the public file preparation, shaped like the DirectusError
// class of @directus/errors (which the bundle cannot import): the API error
// handler renders its status and code, so a manual Flow with
// error_on_reject answers it to Studio and REST callers. Messages name
// files, keys, codes, counts and record ids, never a value.
class DirectusError extends Error {
  public readonly code: string;
  public readonly extensions: Readonly<Record<string, unknown>>;
  public override readonly name = 'DirectusError';
  public readonly reason: ExportErrorCode;
  public readonly status: number;

  public constructor(
    message: string,
    options: ErrorOptions & {
      readonly details?: Readonly<Record<string, unknown>>;
      readonly reason: ExportErrorCode;
    },
  ) {
    super(message, options);
    this.reason = options.reason;
    this.code = `EXPORT_${options.reason}`;
    this.status = exportErrorCodes[options.reason];
    this.extensions = { reason: options.reason, ...options.details };
  }
}

export const exportError = (
  reason: ExportErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): ExportError =>
  new DirectusError(
    message.slice(0, maxExportMessageLength),
    details === undefined ? { reason } : { details, reason },
  );

// Refuses a value a resolver cannot determine unambiguously.
export const unresolved = (message: string): never => {
  throw exportError('UNRESOLVED', message);
};
