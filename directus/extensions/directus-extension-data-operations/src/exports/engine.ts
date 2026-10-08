import { z } from 'zod';

import type { ExportDefinition, Row, RowContext, SourceRead } from './types.js';

import { exportError } from './errors.js';
import {
  type KeyRows,
  keySourcesOf,
  type ResolvedField,
  resolveFields,
} from './field-map.js';
import { keySources } from './key-sources.js';
import { idOf, isAbsent, publicForm } from './values.js';

// The generic export engine: it reads the sources of every definition and
// serializes each file with its field map and value rules; file-check.ts
// validates every payload against its definition. The serialization is
// pure; only the reader touches Directus.

export type SourceReader = (read: SourceRead) => Promise<readonly unknown[]>;

type FileSources = {
  // The rows of each key source the definition places.
  readonly keyRows: KeyRows;
  readonly related: Readonly<Record<string, readonly Row[]>>;
  readonly rows: readonly Row[];
};

type PublicRow = Readonly<Record<string, string>>;

const rowList = z.array(z.record(z.string(), z.unknown()));

// A read result as rows, refused whole when Directus answered anything
// else.
export const rowsOf = (label: string, result: unknown): readonly Row[] => {
  const parsed = rowList.safeParse(result);
  if (!parsed.success) {
    throw exportError('INVALID_READ', `${label} answered no rows`);
  }
  return parsed.data;
};

// The rows of the main read in ascending order of the definition's id
// field, which must be a distinct integer in every row.
const ordered = (
  definition: ExportDefinition,
  rows: readonly Row[],
): ReadonlyArray<{ readonly id: number; readonly row: Row }> => {
  const seen = new Set<number>();
  const keyed = rows.map((row) => {
    const id = idOf(row[definition.orderBy]);
    if (id === null || seen.has(id)) {
      throw exportError(
        'INVALID_READ',
        `${definition.filename}: ${definition.rows.collection} answered a row without a distinct integer ${definition.orderBy}`,
      );
    }
    seen.add(id);
    return { id, row };
  });
  return keyed.toSorted((left, right) => left.id - right.id);
};

const grouped = (
  definition: ExportDefinition,
  related: FileSources['related'],
): ReadonlyMap<string, ReadonlyMap<number, readonly Row[]>> =>
  new Map(
    Object.entries(definition.related).map(([key, read]) => [
      key,
      Map.groupBy(related[key] ?? [], (row) => idOf(row[read.by]) ?? NaN),
    ]),
  );

const publicRow = (
  definition: ExportDefinition,
  fields: readonly ResolvedField[],
  { context, id }: { readonly context: RowContext; readonly id: number },
): PublicRow => {
  const output: Record<string, string> = {};
  for (const entry of fields) {
    const value = entry.value(context);
    if (isAbsent(value)) {
      continue;
    }
    const form = publicForm(entry.rule, value);
    if (form === null) {
      throw exportError(
        'INVALID_PAYLOAD',
        `${definition.filename}: ${definition.orderBy} ${String(id)} key ${entry.key}: ${typeof value}, expected ${entry.rule}`,
      );
    }
    output[entry.key] = form;
  }
  return output;
};

// One public file from its sources: a row per main row in id order, each
// with the declared keys only (keyed entries expanded by their key
// sources), in declaration order.
export const serializeFile = (
  definition: ExportDefinition,
  sources: FileSources,
): PublicRow[] => {
  const fields = resolveFields(definition, sources.keyRows);
  const groups = grouped(definition, sources.related);
  return ordered(definition, sources.rows).map(({ id, row }) =>
    publicRow(definition, fields, {
      context: {
        related: Object.fromEntries(
          Object.keys(definition.related).map((key) => [
            key,
            groups.get(key)?.get(id) ?? [],
          ]),
        ),
        row,
      },
      id,
    }),
  );
};

// The sources of one definition through the reader: its key sources
// first, then its rows and related rows.
export const readFileSources = async (
  definition: ExportDefinition,
  reader: SourceReader,
): Promise<FileSources> => {
  const label = (key: string) => `${definition.filename} read ${key}`;
  const keyRows: Partial<Record<keyof typeof keySources, readonly Row[]>> = {};
  for (const name of keySourcesOf(definition)) {
    keyRows[name] = rowsOf(label(name), await reader(keySources[name]));
  }
  const rows = rowsOf(label('rows'), await reader(definition.rows));
  const related: Record<string, readonly Row[]> = {};
  for (const [key, read] of Object.entries(definition.related)) {
    related[key] = rowsOf(label(key), await reader(read));
  }
  return { keyRows, related, rows };
};
