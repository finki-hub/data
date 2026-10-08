import type { Row, SourceRows, ValueRule } from './types.js';

// The value rules of the public files, one per public key instead of one
// per runtime type: each rule writes a value of its own type (a boolean,
// a number or a string) in the form the consumers read, and a value of
// any other type is refused. Absent means null, undefined or the empty
// string, which the files omit; a required key absent refuses the file.

const absent: ReadonlySet<unknown> = new Set(['', null, undefined]);

export const isAbsent = (value: unknown): boolean => absent.has(value);

// A boolean rule: the text of true and the text of false.
const booleanForm =
  (whenTrue: string, whenFalse: string) =>
  (value: unknown): null | string => {
    if (typeof value !== 'boolean') {
      return null;
    }
    return value ? whenTrue : whenFalse;
  };

const forms: Readonly<Record<ValueRule, (value: unknown) => null | string>> = {
  boolean: booleanForm('TRUE', 'FALSE'),
  number: (value) =>
    typeof value === 'number' && Number.isFinite(value) ? String(value) : null,
  numeric_boolean: booleanForm('1', '0'),
  text: (value) => (typeof value === 'string' ? value : null),
};

// The public text of a present value, or null when the value does not
// have the rule's type.
export const publicForm = (rule: ValueRule, value: unknown): null | string =>
  forms[rule](value);

const isRecord = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// A field of a read row by its dot path, as Directus answers a relational
// field (`entry.code` is `{ entry: { code } }`); undefined when a step of
// the path is missing and null when a relation is empty.
export const pathValue = (row: Row, path: string): unknown => {
  let current: unknown = row;
  for (const step of path.split('.')) {
    if (current === null) {
      return null;
    }
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[step];
  }
  return current;
};

// Non-empty text, or null.
export const textOf = (value: unknown): null | string =>
  typeof value === 'string' && value !== '' ? value : null;

// A safe integer, or null.
export const idOf = (value: unknown): null | number =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

// The rows a readiness check read under a key, or none.
export const sourceRows = (sources: SourceRows, key: string): readonly Row[] =>
  sources[key] ?? [];

// The count an aggregate read of a readiness check answered under a key
// (readiness hands it over as one row `{ count }`), or 0 when absent.
export const countIn = (sources: SourceRows, key: string): number => {
  const [row] = sourceRows(sources, key);
  const count = row?.['count'];
  return typeof count === 'number' ? count : 0;
};
