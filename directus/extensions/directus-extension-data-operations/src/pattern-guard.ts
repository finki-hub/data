import { defineHook } from '@directus/extensions-sdk';

import { patternProblem, yearPatternProblem } from './enrollment-lines.js';

type Payload = Readonly<Record<string, unknown>>;

// A refusal of a pattern mapping write, shaped like the DirectusError class
// of @directus/errors (which the bundle cannot import): the API answers
// HTTP 400 INVALID_PAYLOAD with the field and why, never the pattern.
class DirectusError extends Error {
  public readonly code = 'INVALID_PAYLOAD';
  public readonly extensions: Readonly<Record<string, unknown>>;
  public override readonly name = 'DirectusError';
  public readonly status = 400;

  public constructor(
    message: string,
    options: ErrorOptions & { readonly field: 'pattern' | 'year_pattern' },
  ) {
    super(message, options);
    this.extensions = { field: options.field };
  }
}

const refusal = (field: 'pattern' | 'year_pattern', reason: string) =>
  new DirectusError(`Invalid pattern mapping: ${field}: ${reason}`, { field });

const isPayload = (value: unknown): value is Payload =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Refuses a written pattern that is no Unicode regular expression, and a
// written year pattern that is none or declares no group named start or
// end. A field the payload leaves out is not checked; the database CHECKs
// refuse an empty text, a line break and both or neither of the year
// fields.
export const checkPatternMapping = (payload: unknown): void => {
  if (!isPayload(payload)) {
    return;
  }
  const { pattern, year_pattern: yearPattern } = payload;
  const problem = typeof pattern === 'string' ? patternProblem(pattern) : null;
  if (problem !== null) {
    throw refusal('pattern', problem);
  }
  const yearProblem =
    typeof yearPattern === 'string' ? yearPatternProblem(yearPattern) : null;
  if (yearProblem !== null) {
    throw refusal('year_pattern', yearProblem);
  }
};

// A create with a year and no year pattern gets `year_pattern: null`, as
// Studio clears it: the column default would otherwise set both.
export const patternMappingCreate = (payload: unknown): unknown => {
  checkPatternMapping(payload);
  if (!isPayload(payload) || 'year_pattern' in payload) {
    return payload;
  }
  const year = payload['only_in_year'] ?? null;
  return year === null ? payload : { ...payload, year_pattern: null };
};

// The checks of every pattern mapping create and update through Directus
// (Studio, REST, GraphQL, Flows that emit events, a course form's nested
// rows); a refused write changes nothing.
export const registerPatternGuard = (
  filter: (event: string, handler: (payload: unknown) => unknown) => void,
): void => {
  filter('moodle_pattern_mappings.items.create', patternMappingCreate);
  filter('moodle_pattern_mappings.items.update', (payload) => {
    checkPatternMapping(payload);
    return payload;
  });
};

export default defineHook(({ filter }) => {
  registerPatternGuard(filter);
});
