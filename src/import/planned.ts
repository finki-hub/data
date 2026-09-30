import type { ModelCollectionKey, Scalar, WorkbookKey } from '../schema.js';

// The rows the one-time import writes, planned before anything reaches
// Directus. A row refers to a row the same import creates earlier by its
// collection and plan key; the writer (write.ts) replaces the reference by
// the id Directus gave that row.

export type Ref = {
  readonly collection: ModelCollectionKey;
  readonly key: string;
};

export type PlannedValue = Ref | Scalar;

export type PlannedRecord = Readonly<Record<string, PlannedValue>>;

// The workbook row a planned row comes from: its part of the workbook and
// its ordinal (1 for the first row read).
export type Origin = { readonly id: number; readonly source: WorkbookKey };

export type PlannedRow = {
  readonly key: string;
  readonly origin: null | Origin;
  readonly record: PlannedRecord;
};

export type PlannedCollection = {
  readonly collection: ModelCollectionKey;
  readonly rows: readonly PlannedRow[];
};

const keySeparator = '\u{0}';

export const compositeKey = (
  ...parts: ReadonlyArray<number | string>
): string => parts.map(String).join(keySeparator);

// A plan key as a message shows it: the parts of a composite key joined by
// "/", such as 2023/kn.
export const displayKey = (key: string): string =>
  key.split(keySeparator).join('/');

export const ref = (
  collection: ModelCollectionKey,
  key: number | string,
): Ref => ({ collection, key: String(key) });

export const isRef = (value: PlannedValue): value is Ref =>
  typeof value === 'object' && value !== null;

export const planned = (
  key: number | string,
  record: PlannedRecord,
  origin: null | Origin = null,
): PlannedRow => ({ key: String(key), origin, record });
