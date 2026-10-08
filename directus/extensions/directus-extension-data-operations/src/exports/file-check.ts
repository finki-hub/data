import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { ExportDefinition, Row } from './types.js';

import { exportError } from './errors.js';
import { type KeyRows, resolveFields } from './field-map.js';

// The payload check of the export engine (engine.ts): what a file over its
// sources must hold, and the validation of a payload against it before
// anything is answered. Pure; it reads nothing.

export type PreparedFile = {
  // The compact JSON the file publishes.
  readonly body: string;
  readonly bytes: number;
  readonly filename: string;
  readonly rows: number;
  readonly sha256: string;
};

// The keys a file may carry, in output order, and the keys every one of
// its rows must carry.
type FileKeys = {
  readonly keys: readonly string[];
  readonly required: readonly string[];
};

// What a payload must hold: a row per read row, and the keys the
// definition resolved to for its sources (fileShape). A bare row count
// stands for a definition without key sources.
type FileShape = (FileKeys & { readonly rows: number }) | number;

// The sources a file's shape depends on: its key rows and its read rows.
type ShapeSources = {
  readonly keyRows: KeyRows;
  readonly rows: readonly Row[];
};

const keysOf = (definition: ExportDefinition, keyRows: KeyRows): FileKeys => {
  const fields = resolveFields(definition, keyRows);
  return {
    keys: fields.map(({ key }) => key),
    required: fields.filter(({ required }) => required).map(({ key }) => key),
  };
};

// The keys a file may carry for these sources, in output order.
export const fileKeys = (
  definition: ExportDefinition,
  sources: Pick<ShapeSources, 'keyRows'>,
): readonly string[] => keysOf(definition, sources.keyRows).keys;

// What a payload over these sources must hold, for validateFile.
export const fileShape = (
  definition: ExportDefinition,
  sources: ShapeSources,
): FileShape => ({
  ...keysOf(definition, sources.keyRows),
  rows: sources.rows.length,
});

const payloadSchema = z.array(z.record(z.string(), z.string().min(1)));

// A payload refusal, placed at the file or at one of its rows:
// `<file>[ row <n>]: <fault>`.
const refusePayload = (
  definition: ExportDefinition,
  fault: string,
  row?: number,
): never => {
  const place =
    row === undefined
      ? definition.filename
      : `${definition.filename} row ${String(row)}`;
  throw exportError('INVALID_PAYLOAD', `${place}: ${fault}`);
};

// Every key of a row is declared, once and in declaration order, and
// every required key is there.
const checkKeys = (
  definition: ExportDefinition,
  { keys, required }: FileKeys,
  {
    index,
    row,
  }: { readonly index: number; readonly row: Readonly<Record<string, string>> },
): void => {
  let position = -1;
  for (const key of Object.keys(row)) {
    const next = keys.indexOf(key);
    if (next === -1) {
      refusePayload(definition, `undeclared key ${key.slice(0, 60)}`, index);
    }
    if (next <= position) {
      refusePayload(definition, `key ${key} out of order`, index);
    }
    position = next;
  }
  const missing = required.find((key) => !Object.hasOwn(row, key));
  if (missing !== undefined) {
    refusePayload(definition, `required key ${missing} missing`, index);
  }
};

// Validates a payload against its definition, independently of how it was
// built: an array of one object per read row, every key declared by the
// definition and in its order, every required key present, every value
// non-empty text, and the compact JSON within the definition's size
// bound. Answers the published body.
export const validateFile = (
  definition: ExportDefinition,
  payload: unknown,
  shape: FileShape,
): PreparedFile => {
  const {
    keys,
    required,
    rows: expectedRows,
  } = typeof shape === 'number'
    ? { ...keysOf(definition, {}), rows: shape }
    : shape;
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    return refusePayload(definition, 'not a list of rows of text values');
  }
  if (parsed.data.length !== expectedRows) {
    refusePayload(
      definition,
      `rows ${String(parsed.data.length)}, expected ${String(expectedRows)}`,
    );
  }
  for (const [index, row] of parsed.data.entries()) {
    checkKeys(definition, { keys, required }, { index, row });
  }
  const body = JSON.stringify(parsed.data);
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > definition.maxBytes) {
    refusePayload(
      definition,
      `${String(bytes)} bytes, max ${String(definition.maxBytes)}`,
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
