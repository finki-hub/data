import { createHash } from 'node:crypto';
import { z } from 'zod';

import {
  calculationDomains,
  domainDeclarations,
  type DomainKind,
  domainKinds,
  nextCalculation,
} from './domains.js';
import { textCollator } from './state.js';

// The fingerprints of the managed Flow graph, one per domain kind: a
// calculation runs under the calculation fingerprint, a publication under
// the publication fingerprint, which includes the calculation fingerprint,
// so a calculation change requeues publication too and a publish-only
// change never requeues a calculation.
export type Fingerprints = {
  readonly calculation: string;
  readonly publication: string;
};

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

// What makes a Flow a root of a graph, by the action of a coordinate step
// it holds: a claim of a calculation domain or next_calculation and the
// page steps (plan, stage, index) root the calculation graph, a claim of
// publication the publication graph. Mark, status, heartbeat, record,
// complete and fail root neither: a Flow holding only those (Mark pending
// and its dialog) is in no graph, and a child that records or completes a
// claim's work is reached from the Flow that claimed. A templated, unknown
// or missing action or claim domain roots both. graphSql applies the same
// rule in SQL.
export const pageStepActions = ['plan_pages', 'stage_page', 'index_page'];

export const neutralActions = [
  'mark',
  'status',
  'heartbeat',
  'record',
  'complete',
  'fail',
];

export const calculationTargets: readonly string[] = [
  ...calculationDomains,
  nextCalculation,
];

// The claim domains that root the publication graph: the declared
// publication domains.
export const publicationTargets: readonly string[] = domainDeclarations
  .filter(({ kind }) => kind === 'publication')
  .map(({ name }) => name);

const textOf = (options: unknown, key: string): null | string => {
  const value = isRecord(options) ? options[key] : undefined;
  return typeof value === 'string' ? value : null;
};

// The graphs a coordinate step with these options roots its Flow in.
export const graphKindsOf = (options: unknown): readonly DomainKind[] => {
  const action = textOf(options, 'action');
  if (action !== null && neutralActions.includes(action)) {
    return [];
  }
  if (action !== null && pageStepActions.includes(action)) {
    return ['calculation'];
  }
  const domain = textOf(options, 'domain');
  if (action === 'claim' && domain !== null) {
    if (calculationTargets.includes(domain)) {
      return ['calculation'];
    }
    if (publicationTargets.includes(domain)) {
      return ['publication'];
    }
  }
  return ['calculation', 'publication'];
};

// One row per operation of every Flow of a graph (graphSql: the Flows a
// coordinate step roots in it and every Flow they reach through Trigger
// Flow operations): the trigger configuration, the entry operation, and
// each operation's key, type, options and edges. Names, descriptions,
// icons, colours, positions, status and accountability are not part of it.
export type GraphRow = {
  readonly entry: null | string;
  readonly flow: string;
  readonly flow_options: unknown;
  readonly graph: DomainKind;
  readonly key: null | string;
  readonly operation: null | string;
  readonly options: unknown;
  readonly reject: null | string;
  readonly resolve: null | string;
  readonly trigger: null | string;
  readonly type: null | string;
};

// The rows graphSql answers, as the SQL port reads them.
export const graphRowsSchema = z.array(
  z.object({
    entry: z.string().nullable(),
    flow: z.string(),
    flow_options: z.unknown(),
    graph: z.enum(domainKinds),
    key: z.string().nullable(),
    operation: z.string().nullable(),
    options: z.unknown(),
    reject: z.string().nullable(),
    resolve: z.string().nullable(),
    trigger: z.string().nullable(),
    type: z.string().nullable(),
  }),
);

const digest = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

const rowsOf = (rows: readonly GraphRow[], kind: DomainKind) =>
  rows
    .filter(({ graph }) => graph === kind)
    .map(
      ({
        entry,
        flow,
        flow_options,
        key,
        operation,
        options,
        reject,
        resolve,
        trigger,
        type,
      }) => ({
        entry,
        flow,
        flow_options,
        key,
        operation,
        options,
        reject,
        resolve,
        trigger,
        type,
      }),
    );

export const fingerprintsOfGraph = (
  rows: readonly GraphRow[],
): Fingerprints => {
  const calculation = digest(canonicalJson(rowsOf(rows, 'calculation')));
  return {
    calculation,
    publication: digest(
      canonicalJson({ calculation, graph: rowsOf(rows, 'publication') }),
    ),
  };
};
