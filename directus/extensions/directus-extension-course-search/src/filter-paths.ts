import { z } from 'zod';

// A Search filter path names at most as many fields as REST allows
// (MAX_RELATIONAL_DEPTH): the item services the endpoint calls skip the
// REST query validation that checks it. Every key that is no operator,
// group or quantifier (`_...`) names one more field.

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Why Search refuses a path, if it does: a fact the endpoint places after
// "Invalid criteria: filter: ".
const walkProblem = (
  filter: unknown,
  depth: number,
  maxDepth: number,
): string | undefined => {
  const items = Array.isArray(filter) ? filter : [filter];
  for (const item of items) {
    if (!isRecord(item)) continue;
    for (const [key, value] of Object.entries(item)) {
      // An operator, group or quantifier stays where it is.
      const next = key.startsWith('_') ? depth : depth + 1;
      if (next > maxDepth) return `path exceeds ${String(maxDepth)} fields`;
      const problem = walkProblem(value, next, maxDepth);
      if (problem !== undefined) return problem;
    }
  }
  return undefined;
};

// Why Search refuses a native filter's paths, or undefined when each path
// names at most `maxDepth` fields.
export const filterPathProblem = (
  filter: unknown,
  maxDepth: number,
): string | undefined => walkProblem(filter, 0, maxDepth);

// Directus's own limit on the fields of a query path: MAX_RELATIONAL_DEPTH
// (default 10), and never below 2 (utils/validate-query.js).
export const relationalDepthLimit = (
  env: Readonly<Record<string, unknown>>,
): number => {
  const configured = z.coerce.number().safeParse(env['MAX_RELATIONAL_DEPTH']);
  return configured.success ? Math.max(configured.data, 2) : 2;
};
