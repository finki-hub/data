import type {
  ExportDefinition,
  FieldEntry,
  KeyedEntry,
  KeySourceName,
  Row,
  RowContext,
  ValueRule,
} from './types.js';

import { exportError } from './errors.js';
import { keySources } from './key-sources.js';
import { pathValue, textOf } from './values.js';

// The concrete field map of one preparation: every fixed entry as declared
// and every keyed entry expanded into one key per row of its key source,
// at the entry's position and in the source's order.

// The rows each key source answered, by source name.
export type KeyRows = Readonly<Partial<Record<KeySourceName, readonly Row[]>>>;

export type ResolvedField = {
  readonly key: string;
  readonly rule: ValueRule;
  readonly value: (context: RowContext) => unknown;
};

export const isKeyed = (entry: FieldEntry): entry is KeyedEntry =>
  'keys' in entry;

// The key sources a definition places, each once, in field order.
export const keySourcesOf = (
  definition: ExportDefinition,
): readonly KeySourceName[] => [
  ...new Set(
    definition.fields.flatMap((entry) => (isKeyed(entry) ? [entry.keys] : [])),
  ),
];

const descending = /^-/u;

// PostgreSQL's order of two values of one sort field: numbers by value,
// text by code point, NULL after every value ascending.
const compareValues = (left: unknown, right: unknown): number => {
  const leftAbsent = left === null || left === undefined;
  const rightAbsent = right === null || right === undefined;
  if (leftAbsent || rightAbsent) {
    return Number(leftAbsent) - Number(rightAbsent);
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }
  const [a, b] = [JSON.stringify(left), JSON.stringify(right)];
  return a < b ? -1 : Number(a > b);
};

// The key rows in the order their source declares (`-field` descending),
// whatever order the read answered them in.
const ordered = (rows: readonly Row[], sort: readonly string[]): Row[] =>
  rows.toSorted((left, right) => {
    for (const entry of sort) {
      const field = entry.replace(descending, '');
      const order =
        compareValues(left[field], right[field]) *
        (entry.startsWith('-') ? -1 : 1);
      if (order !== 0) {
        return order;
      }
    }
    return 0;
  });

const expand = (
  definition: ExportDefinition,
  entry: KeyedEntry,
  rows: readonly Row[],
): ResolvedField[] =>
  ordered(rows, keySources[entry.keys].sort).map((row) => {
    const key = textOf(row[keySources[entry.keys].key]);
    if (key === null) {
      throw exportError(
        'INVALID_READ',
        `${definition.filename}: a ${entry.keys} row answered no key text; nothing was prepared`,
      );
    }
    return {
      key,
      rule: entry.rule,
      value: (context) => entry.value(context, row),
    };
  });

const fixed = (entry: Exclude<FieldEntry, KeyedEntry>): ResolvedField => ({
  key: entry.key,
  rule: entry.rule,
  value: (context) =>
    typeof entry.value === 'string'
      ? pathValue(context.row, entry.value)
      : entry.value(context),
});

// The keys of one preparation in output order, each once: a key-source
// row whose key text equals another key would make the file ambiguous,
// so it is refused for an editor to rename.
export const resolveFields = (
  definition: ExportDefinition,
  keyRows: KeyRows = {},
): readonly ResolvedField[] => {
  const fields = definition.fields.flatMap((entry) =>
    isKeyed(entry)
      ? expand(definition, entry, keyRows[entry.keys] ?? [])
      : [fixed(entry)],
  );
  const seen = new Set<string>();
  for (const { key } of fields) {
    if (seen.has(key)) {
      throw exportError(
        'UNRESOLVED',
        `${definition.filename} would publish the key ${key.slice(0, 60)} twice: a key-source row names another key; nothing was prepared.`,
      );
    }
    seen.add(key);
  }
  return fields;
};
