import { type CoordinationError, coordinationError } from './errors.js';

// The coordinator refusals that several actions raise, each worded once.

type RefusalOptions = Parameters<typeof coordinationError>[2];

// An action of one claim domain under a claim of another:
// `<subject>: claim domain <actual>, expected <expected>`.
export const domainMismatch = (
  mismatch: {
    readonly actual: null | string;
    readonly expected: string;
    readonly subject: string;
  },
  options?: RefusalOptions,
): CoordinationError =>
  coordinationError(
    'DOMAIN_MISMATCH',
    `${mismatch.subject}: claim domain ${mismatch.actual ?? 'none'}, expected ${mismatch.expected}`,
    options,
  );

// A page token the claim's plan does not hold.
export const pageUnplanned = (page: string): CoordinationError =>
  coordinationError('PAGE_UNPLANNED', `Page ${page} not planned`);
