import { createHash } from 'node:crypto';

import { textCollator } from './state.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// JSON with object keys sorted at every level, so two graphs that differ
// only in key order or in undefined members fingerprint the same.
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    const members = Object.keys(value)
      .sort((left, right) => textCollator.compare(left, right))
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

// One row per operation of every managed Flow (graphSql: the Flows holding
// a coordinate operation and every Flow they reach through Trigger Flow
// operations): the trigger configuration, the entry operation, and each
// operation's key, type, options and edges. Names, descriptions, icons,
// colours, positions, status and accountability are not part of it.
export type GraphRow = {
  readonly entry: null | string;
  readonly flow: string;
  readonly flow_options: unknown;
  readonly key: null | string;
  readonly operation: null | string;
  readonly options: unknown;
  readonly reject: null | string;
  readonly resolve: null | string;
  readonly trigger: null | string;
  readonly type: null | string;
};

export const fingerprintOfGraph = (rows: readonly GraphRow[]): string =>
  createHash('sha256').update(canonicalJson(rows)).digest('hex');
