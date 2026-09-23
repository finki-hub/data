import { z } from 'zod';

import type { ActionContext } from '../directus/extensions/directus-extension-data-operations/src/coordination/action-support.js';
import type { StateRow } from '../directus/extensions/directus-extension-data-operations/src/coordination/sql-state.js';
import type { FlowTemplate } from '../src/flows/flow-template.js';

import { runAction } from '../directus/extensions/directus-extension-data-operations/src/coordination/actions.js';
import {
  fingerprintOfGraph,
  type GraphRow,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/fingerprint.js';
import {
  type SqlDatabase,
  sqlStore,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/sql-port.js';
import { claimStaleAfterMs } from '../directus/extensions/directus-extension-data-operations/src/coordination/state.js';
import { statusAction } from '../directus/extensions/directus-extension-data-operations/src/coordination/status.js';
import { FakeCoordination } from './data-coordination-helpers.js';

export const processA = 'process-a';

export const context = (fake: FakeCoordination): ActionContext => ({
  owner: processA,
  staleAfterMs: claimStaleAfterMs,
  store: fake.store,
});

export const claimed = z.object({
  claimed: z.literal(true),
  domain: z.string(),
  revision: z.number(),
  token: z.string(),
});

// One tick of the schedule: a claim of the next pending calculation.
export const tick = (fake: FakeCoordination, owner = processA) =>
  runAction(
    { action: 'claim', domain: 'next_calculation', retry: false },
    { ...context(fake), owner },
  );

export const claimNext = async (fake: FakeCoordination) =>
  claimed.parse(await tick(fake));

// Completes a claim the way the children do: a history run plans and
// indexes nothing on an empty fake; an enrollment run plans no page.
export const finish = async (fake: FakeCoordination, token: string) => {
  const source =
    fake.data.claim?.domain === 'history_index' ? 'history' : 'rules';
  await runAction({ action: 'plan_pages', source, token }, context(fake));
  return runAction({ action: 'complete', token }, context(fake));
};

export const fail = (fake: FakeCoordination, token: string, message: string) =>
  runAction(
    { action: 'fail', code: 'LEGACY_COUNT_FAILED', message, token },
    context(fake),
  );

export const status = (fake: FakeCoordination) => statusAction(context(fake));

// A fresh fake whose calculations ran at the current graph, with the given
// source tables written since.
export const settled = (...tables: string[]): FakeCoordination => {
  const fake = new FakeCoordination();
  fake.data.calculationFingerprint = fake.fingerprint;
  fake.data.publicationFingerprint = fake.fingerprint;
  for (const table of tables) {
    fake.sourceWrite(table);
  }
  return fake;
};

// One managed operation of the graph the recording database answers.
export const graphRows: readonly GraphRow[] = [
  {
    entry: 'op-1',
    flow: 'flow-1',
    flow_options: { cron: '*/15 * * * * *' },
    key: 'claim',
    operation: 'op-1',
    options: { action: 'claim', domain: 'next_calculation' },
    reject: null,
    resolve: null,
    trigger: 'schedule',
    type: 'finki-hub-data-coordinate',
  },
];

export const graphFingerprint = fingerprintOfGraph(graphRows);

// The coordination singleton as the SQL port reads it: nothing dirty, the
// last calculation at the current graph, no claim, unless overridden.
export const stateRowOf = (overrides: Partial<StateRow> = {}): StateRow => ({
  calculation_fingerprint: graphFingerprint,
  claim_domain: null,
  claim_fingerprint: null,
  claim_heartbeat_age_ms: null,
  claim_heartbeat_iso: null,
  claim_owner: null,
  claim_pages: null,
  claim_revision: null,
  claim_staged: null,
  claim_started_iso: null,
  claim_token: null,
  completed_revision: 7,
  dirty_domains: ['publication'],
  enrollments_input_revision: null,
  finished_iso: null,
  history_index_input_revision: null,
  import_state: 'idle',
  last_error_code: null,
  last_error_iso: null,
  last_error_message: null,
  last_failed_domain: null,
  last_failed_fingerprint: null,
  last_failed_revision: null,
  publication_fingerprint: graphFingerprint,
  publication_outcomes: null,
  publication_state: 'idle',
  requested_revision: 7,
  source_revision: 7,
  started_iso: null,
  ...overrides,
});

const tablePattern = /\b(?:FROM|INTO|JOIN|UPDATE)\s+"(?<table>[a-z_]+)"/gu;

// The quoted tables a statement reads or writes.
export const tablesOf = (sql: string): string[] =>
  sql
    .matchAll(tablePattern)
    .map((match) => match.groups?.['table'] ?? '')
    .toArray();

// A SQL database that answers the statements of a claim from one status
// row and records every statement it is sent, the SQL port's own view of
// what a tick reads and writes.
export const recordingDatabase = (row: StateRow) => {
  const statements: string[] = [];
  const answer = (sql: string) => {
    statements.push(sql);
    if (sql.startsWith('SELECT') && sql.includes('FROM "data_operations"')) {
      return { rowCount: 1, rows: [row] };
    }
    if (sql.startsWith('WITH RECURSIVE "managed"')) {
      return { rowCount: graphRows.length, rows: graphRows };
    }
    return { rowCount: 1, rows: [] };
  };
  const database: SqlDatabase = {
    raw: async (sql) => answer(sql),
    transaction: async (work) => work({ raw: async (sql) => answer(sql) }),
  };
  return {
    context: (): ActionContext => ({
      owner: processA,
      staleAfterMs: claimStaleAfterMs,
      store: sqlStore(database),
    }),
    statements,
  };
};

// Every Flow a template set reaches from its Flows that hold a coordinate
// operation, following Trigger Flow operations: the graph the fingerprint
// covers once the templates are installed.
export const managedFlowIds = (
  templates: readonly FlowTemplate[],
): Set<string> => {
  const managed = new Set(
    templates
      .filter((flow) =>
        flow.operations.some(
          ({ type }) => type === 'finki-hub-data-coordinate',
        ),
      )
      .map(({ id }) => id),
  );
  const edges = templates.flatMap((flow) =>
    flow.operations.flatMap(({ options, type }) => {
      const child = options['flow'];
      return type === 'trigger' && typeof child === 'string'
        ? [{ child, parent: flow.id }]
        : [];
    }),
  );
  let size = 0;
  while (size !== managed.size) {
    size = managed.size;
    for (const { child, parent } of edges) {
      if (managed.has(parent)) {
        managed.add(child);
      }
    }
  }
  return managed;
};
