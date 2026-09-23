import { createHash } from 'node:crypto';
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

// The generic export engine: it reads the sources of every definition,
// serializes each file with its field map and value rules and validates
// every payload against its definition. The serialization and the
// validation are pure; only the reader touches Directus.

export type FileSources = {
  // The rows of each key source the definition places.
  readonly keyRows: KeyRows;
  readonly related: Readonly<Record<string, readonly Row[]>>;
  readonly rows: readonly Row[];
};

export type PreparedFile = {
  // The compact JSON the file publishes.
  readonly body: string;
  readonly bytes: number;
  readonly filename: string;
  readonly rows: number;
  readonly sha256: string;
};

export type PublicRow = Readonly<Record<string, string>>;

export type SourceReader = (read: SourceRead) => Promise<readonly unknown[]>;

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
        `${definition.filename}: ${definition.orderBy} ${id} answered a ${typeof value} for ${entry.key}, which the definition publishes as ${entry.rule}; nothing was prepared`,
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

// The keys a file may carry for these sources, in output order.
export const fileKeys = (
  definition: ExportDefinition,
  sources: Pick<FileSources, 'keyRows'>,
): readonly string[] =>
  resolveFields(definition, sources.keyRows).map(({ key }) => key);

const payloadSchema = z.array(z.record(z.string(), z.string().min(1)));

const refusePayload = (
  definition: ExportDefinition,
  problem: string,
): never => {
  throw exportError(
    'INVALID_PAYLOAD',
    `${definition.filename} ${problem}; nothing may be published`,
  );
};

// Every key of a row is declared, once and in declaration order.
const checkKeys = (
  definition: ExportDefinition,
  declared: readonly string[],
  { index, row }: { readonly index: number; readonly row: PublicRow },
): void => {
  let position = -1;
  for (const key of Object.keys(row)) {
    const next = declared.indexOf(key);
    if (next === -1) {
      refusePayload(
        definition,
        `row ${index} carries the undeclared key ${key.slice(0, 60)}`,
      );
    }
    if (next <= position) {
      refusePayload(definition, `row ${index} lists ${key} out of order`);
    }
    position = next;
  }
};

// What a payload must hold: a row per read row, and the keys the
// definition resolved to for its sources (fileKeys). A bare row count
// stands for a definition without key sources.
export type FileShape =
  number | { readonly keys: readonly string[]; readonly rows: number };

// Validates a payload against its definition, independently of how it was
// built: an array of one object per read row, every key declared by the
// definition and in its order, every value non-empty text, and the compact
// JSON within the definition's size bound. Answers the published body.
export const validateFile = (
  definition: ExportDefinition,
  payload: unknown,
  shape: FileShape,
): PreparedFile => {
  const { keys, rows: expectedRows } =
    typeof shape === 'number'
      ? { keys: fileKeys(definition, { keyRows: {} }), rows: shape }
      : shape;
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    return refusePayload(definition, 'is not a list of rows of text values');
  }
  if (parsed.data.length !== expectedRows) {
    refusePayload(
      definition,
      `holds ${parsed.data.length} rows for ${expectedRows} read`,
    );
  }
  for (const [index, row] of parsed.data.entries()) {
    checkKeys(definition, keys, { index, row });
  }
  const body = JSON.stringify(parsed.data);
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > definition.maxBytes) {
    refusePayload(
      definition,
      `has ${bytes} bytes, above its bound of ${definition.maxBytes}`,
    );
  }
  return {
    body,
    bytes,
    filename: definition.filename,
    rows: parsed.data.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
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
