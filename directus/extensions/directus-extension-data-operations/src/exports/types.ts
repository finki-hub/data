import type { Filter } from '@directus/types';

// The shapes of the declarative export layer. Every published file is one
// ExportDefinition: the native reads it needs, the order of its rows and
// an ordered field map whose keys are the whole allowlist of the file.
// Generic code (engine.ts) reads, serializes and validates every
// definition; nothing else knows a file's format.

// A read of rows related to the rows of a file, grouped by `by`: the field
// holding the id of the file's row (for example `course`). Rows whose `by`
// names no row of the file are not used.
export type RelatedRead = SourceRead & { readonly by: string };

// Computes one public value from a row and its related rows. It returns
// null (or undefined, or '') when the value is absent, and throws an
// export error when it cannot resolve the value unambiguously; it never
// guesses.
export type Resolver = (context: RowContext) => unknown;

export type Row = Readonly<Record<string, unknown>>;

// What a resolver sees: one row of the file's main read and its related
// rows, per related read key, in read order.
export type RowContext = {
  readonly related: Readonly<Record<string, readonly Row[]>>;
  readonly row: Row;
};

// One native read: a collection, an explicit field list (relational dot
// paths through M2O relations allowed, never `*`), a sort and optionally a
// filter (plain field and M2O paths only, never `_some` or `_none`). An
// aggregate read answers one bounded count over its one field instead of
// rows (`count` of the matching rows, `countDistinct` of their values).
export type SourceRead = {
  readonly aggregate?: Aggregate;
  readonly collection: string;
  readonly fields: readonly string[];
  readonly filter?: Filter;
  readonly sort: readonly string[];
};

export const aggregates = ['count', 'countDistinct'] as const;

export type Aggregate = (typeof aggregates)[number];

// A read whose rows each name one public key, in read order: the key is
// the text of the row's `key` field.
export type KeySource = SourceRead & { readonly key: string };

// The closed vocabulary of public value forms, as the reference serializer
// (directus/flows/serialize-assets.cjs) writes them: text as is, a number
// as its decimal text, a numeric boolean as "1"/"0", any other boolean as
// "TRUE"/"FALSE". Every rule omits null, undefined and ''; false and 0
// are kept. A value of another type is refused, never converted.
export const valueRules = [
  'text',
  'number',
  'numeric_boolean',
  'boolean',
] as const;

export type ExportDefinition = {
  // The ordered field map: output key order and the file's allowlist.
  readonly fields: readonly FieldEntry[];
  // A root-level JSON filename the publish-json storage writer accepts.
  readonly filename: string;
  // The largest compact JSON body the file may reach, in UTF-8 bytes.
  readonly maxBytes: number;
  // The integer id field of `rows` that orders the file ascending.
  readonly orderBy: string;
  readonly related: Readonly<Record<string, RelatedRead>>;
  // One public row per row of this read.
  readonly rows: SourceRead;
};

export type FieldEntry = FixedEntry | KeyedEntry;

// One public key: its value is a source path of the main row (for example
// `name`, or `entry.code` when that dot path is read) or a resolver.
export type FixedEntry = {
  readonly key: string;
  readonly rule: ValueRule;
  readonly value: Resolver | string;
};

export type IssueCounts = Readonly<Record<string, number>>;

// One public key per row of a key source (key-sources.ts), in the source's
// order and at this entry's position: the key is the row's key text, the
// value the resolver's answer for the file row and that key row. A row the
// source does not read adds no key.
export type KeyedEntry = {
  readonly keys: KeySourceName;
  readonly rule: ValueRule;
  readonly value: (context: RowContext, keyRow: Row) => unknown;
};

// The closed vocabulary of key sources (key-sources.ts).
export type KeySourceName = 'published_years';

// A readiness check counted in code: its native reads (rows of ids and
// keys, or bounded counts) and a pure evaluation answering a whole count
// for each registry code whose source names it. Counts only, never a
// record.
export type ReadinessCheck = {
  readonly evaluate: (sources: SourceRows) => IssueCounts;
  readonly reads: Readonly<Record<string, SourceRead>>;
};

export type SourceRows = Readonly<Record<string, readonly Row[]>>;

export type ValueRule = (typeof valueRules)[number];

// The filename rule of the publish-json storage writer
// (directus/extensions/directus-extension-publish-json/api.js).
export const publicFilenamePattern = /^[a-z0-9][a-z0-9._-]*\.json$/u;

// The default size bound of a public file (compact JSON, UTF-8 bytes).
export const defaultMaxBytes = 16 * 1_024 * 1_024;
