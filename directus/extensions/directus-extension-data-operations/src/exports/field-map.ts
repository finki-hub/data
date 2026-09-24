import type {
  BlockEntry,
  BlockPart,
  ExportDefinition,
  FieldEntry,
  FixedEntry,
  KeyedEntry,
  KeySourceName,
  NestedKeys,
  Row,
  RowContext,
  ValueRule,
} from './types.js';

import { exportError } from './errors.js';
import { keySources } from './key-sources.js';
import { idOf, pathValue, textOf } from './values.js';

// The concrete field map of one preparation: every fixed entry as declared,
// every keyed entry expanded into one key per row of its key source and
// every block entry into one block of keys per row of its source, at the
// entry's position and in the source's order.

// The rows each key source answered, by source name.
export type KeyRows = Readonly<Partial<Record<KeySourceName, readonly Row[]>>>;

export type ResolvedField = {
  readonly key: string;
  readonly rule: ValueRule;
  readonly value: (context: RowContext) => unknown;
};

export const isKeyed = (entry: FieldEntry): entry is KeyedEntry =>
  'keys' in entry;

export const isBlock = (entry: FieldEntry): entry is BlockEntry =>
  'blocks' in entry;

export const isFixed = (entry: FieldEntry): entry is FixedEntry =>
  'key' in entry;

export const isNested = (part: BlockPart): part is NestedKeys =>
  'nested' in part;

// Every part of a block entry, whichever layout declares it.
export const blockParts = (entry: BlockEntry): readonly BlockPart[] => [
  ...entry.layouts.default,
  ...Object.values(entry.layouts.byKey).flat(),
];

// The key sources a definition places, each once, in field order: keyed
// and block sources, then the nested sources of the blocks.
export const keySourcesOf = (
  definition: ExportDefinition,
): readonly KeySourceName[] => [
  ...new Set(
    definition.fields.flatMap((entry): KeySourceName[] => {
      if (isKeyed(entry)) {
        return [entry.keys];
      }
      if (isBlock(entry)) {
        return [
          entry.blocks,
          ...blockParts(entry).flatMap((part) =>
            isNested(part) ? [part.nested] : [],
          ),
        ];
      }
      return [];
    }),
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

// The key rows of a source in the order it declares (`-field`
// descending), whatever order the read answered them in.
const ordered = (name: KeySourceName, rows: readonly Row[]): Row[] => {
  const { sort } = keySources[name];
  return rows.toSorted((left, right) => {
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
};

type Expansion = {
  readonly definition: ExportDefinition;
  readonly keyRows: KeyRows;
};

// The key text of a key-source row, refused when it has none.
const keyText = (
  { definition }: Expansion,
  name: KeySourceName,
  row: Row,
): string => {
  const key = textOf(row[keySources[name].key]);
  if (key === null) {
    throw exportError(
      'INVALID_READ',
      `${definition.filename}: a ${name} row answered no key text; nothing was prepared`,
    );
  }
  return key;
};

const rowsFor = (expansion: Expansion, name: KeySourceName): Row[] =>
  ordered(name, expansion.keyRows[name] ?? []);

const expand = (expansion: Expansion, entry: KeyedEntry): ResolvedField[] =>
  rowsFor(expansion, entry.keys).map((row) => {
    const key = keyText(expansion, entry.keys, row);
    return {
      key: entry.suffix === undefined ? key : `${key}-${entry.suffix}`,
      rule: entry.rule,
      value: (context) => entry.value(context, row),
    };
  });

// The nested rows that belong to a block row, in the nested order.
const nestedRows = (
  expansion: Expansion,
  part: NestedKeys,
  blockRow: Row,
): Row[] => {
  const { parent } = keySources[part.nested];
  const id = idOf(blockRow['id']);
  return rowsFor(expansion, part.nested).filter(
    (row) => parent !== undefined && id !== null && idOf(row[parent]) === id,
  );
};

const blockPart = (
  expansion: Expansion,
  { block, part, row }: { block: string; part: BlockPart; row: Row },
): ResolvedField[] => {
  if (!isNested(part)) {
    return [
      {
        key: `${block}-${part.suffix}`,
        rule: part.rule,
        value: (context) => part.value(context, row),
      },
    ];
  }
  return nestedRows(expansion, part, row).map((nested) => ({
    key: `${block}-${part.infix}-${keyText(expansion, part.nested, nested)}`,
    rule: part.rule,
    value: (context) => part.value(context, row, nested),
  }));
};

// The layout declared for a block's key text, else the default. Only a
// declared key counts, never a name every object inherits: a generation
// an administrator codes `constructor` follows the default layout.
const layoutOf = ({ layouts }: BlockEntry, block: string) =>
  (Object.hasOwn(layouts.byKey, block) ? layouts.byKey[block] : undefined) ??
  layouts.default;

const blocks = (expansion: Expansion, entry: BlockEntry): ResolvedField[] =>
  rowsFor(expansion, entry.blocks).flatMap((row) => {
    const block = keyText(expansion, entry.blocks, row);
    return layoutOf(entry, block).flatMap((part) =>
      blockPart(expansion, { block, part, row }),
    );
  });

const fixed = (entry: FixedEntry): ResolvedField => ({
  key: entry.key,
  rule: entry.rule,
  value: (context) =>
    typeof entry.value === 'string'
      ? pathValue(context.row, entry.value)
      : entry.value(context),
});

// The one key text a row object cannot hold as a value: assigning it sets
// the prototype, so the key would leave the file without an error.
const unkeyable = '__proto__';

// The keys of one preparation in output order, each once: a key-source
// row whose key text makes a key equal to another key would make the file
// ambiguous, and one that makes `__proto__` would lose it, so either is
// refused for an editor to rename.
export const resolveFields = (
  definition: ExportDefinition,
  keyRows: KeyRows = {},
): readonly ResolvedField[] => {
  const expansion = { definition, keyRows };
  const fields = definition.fields.flatMap((entry) => {
    if (isKeyed(entry)) {
      return expand(expansion, entry);
    }
    return isBlock(entry) ? blocks(expansion, entry) : [fixed(entry)];
  });
  const seen = new Set<string>();
  for (const { key } of fields) {
    if (key === unkeyable || seen.has(key)) {
      throw exportError(
        'UNRESOLVED',
        key === unkeyable
          ? `${definition.filename} cannot publish the key ${unkeyable}, which a key-source row names; nothing was prepared.`
          : `${definition.filename} would publish the key ${key.slice(0, 60)} twice: a key-source row names another key; nothing was prepared.`,
      );
    }
    seen.add(key);
  }
  return fields;
};
