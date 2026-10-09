import type { SourceRead } from './types.js';

// The rules every export and readiness read obeys, and every review view
// filter: explicit fields (never `*`), each once, and no `_some` or `_none`
// anywhere in a filter (Directus 12.3.1 drops a two-condition `_some`
// silently and matches two `_some` blocks across different rows).

const forbiddenOperators: ReadonlySet<string> = new Set(['_none', '_some']);

// Every object key anywhere inside a filter.
const keysOf = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item) => keysOf(item));
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, inner]) => [
    key,
    ...keysOf(inner),
  ]);
};

// Whether a filter uses `_some` or `_none` at any depth.
export const usesSomeOrNone = (filter: unknown): boolean =>
  keysOf(filter).some((key) => forbiddenOperators.has(key));

export const readProblems = (label: string, read: SourceRead): string[] => {
  const problems: string[] = [];
  if (read.fields.length === 0) {
    problems.push(`${label} selects no field`);
  }
  if (read.fields.some((field) => field === '*' || field.endsWith('.*'))) {
    problems.push(`${label} selects a wildcard`);
  }
  if (new Set(read.fields).size !== read.fields.length) {
    problems.push(`${label} selects a field twice`);
  }
  if (read.aggregate !== undefined && read.fields.length !== 1) {
    problems.push(`${label} aggregates more than one field`);
  }
  if (usesSomeOrNone(read.filter)) {
    problems.push(`${label} filters with _some or _none`);
  }
  return problems;
};
