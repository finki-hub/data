import type {
  ApiExtensionContext,
  NestedDeepQuery,
  Query,
} from '@directus/types';

import type { SourceReader } from './engine.js';
import type { ExportDeps } from './prepare.js';
import type { SourceRead } from './types.js';

import { coordinationContext, sqlDatabase } from '../coordinate.js';
import { calculationDomains } from '../coordination/domains.js';
import { statusAction, type StatusReport } from '../coordination/status.js';
import { snapshotReport, type SnapshotReport } from '../snapshot/report.js';
import { snapshotStore } from '../snapshot/sql-port.js';
import {
  type CoordinationFacts,
  type SnapshotFacts,
} from './readiness-facts.js';

// The Directus side of the export operation (and of the status endpoint,
// which counts readiness the same way): native reads through the
// ItemsService, the coordinator status and the snapshot status.

// The deep query that reads every relation a field path steps through
// whole. Directus cuts the list of an O2M or M2M step under each row to
// QUERY_LIMIT_DEFAULT, before it sorts it, unless the read names a limit
// (merge-with-parent-items.js), so a state row of an entry would go
// missing without an error; every relational step gets `_limit: -1`, like
// the top-level read (an M2O step is read whole either way).
export const wholeNested = (
  paths: ReadonlyArray<readonly string[]>,
): NestedDeepQuery => {
  const steps = new Map<string, Array<readonly string[]>>();
  for (const [head, ...rest] of paths) {
    if (head !== undefined && rest.length > 0) {
      steps.set(head, [...(steps.get(head) ?? []), rest]);
    }
  }
  const deep: NestedDeepQuery = {};
  for (const [field, rest] of steps) {
    deep[field] = { ...wholeNested(rest), _limit: -1 };
  }
  return deep;
};

// The native query of a read: an aggregate answers its one count row; a
// row read answers every matching row, each relation it steps through
// whole.
export const readQuery = (read: SourceRead): Query => {
  const filter = read.filter === undefined ? {} : { filter: read.filter };
  if (read.aggregate !== undefined) {
    return { aggregate: { [read.aggregate]: [...read.fields] }, ...filter };
  }
  const deep = wholeNested(read.fields.map((field) => field.split('.')));
  return {
    ...(Object.keys(deep).length > 0 && { deep }),
    fields: [...read.fields],
    ...filter,
    limit: -1,
    sort: [...read.sort],
  };
};

// Reads as the system (accountability null): the operation checks the
// caller's administrator flag itself before anything else (so does the
// status endpoint), and every read names its fields explicitly, so no
// private column is ever selected.
// Events are not emitted and the whole result is read at once.
export const itemsReader = async (
  context: ApiExtensionContext,
): Promise<SourceReader> => {
  const schema = await context.getSchema({ database: context.database });
  return (read) => {
    const items = new context.services.ItemsService(read.collection, {
      accountability: null,
      knex: context.database,
      schema,
    });
    return items.readByQuery(readQuery(read), { emitEvents: false });
  };
};

export const coordinationFacts = (report: StatusReport): CoordinationFacts => ({
  calculation: report.fingerprints.calculation,
  domains: Object.fromEntries(
    calculationDomains.map((domain) => [
      domain,
      report.domains[domain]?.state ?? 'unknown',
    ]),
  ),
  revision: report.revisions.source,
});

export const snapshotFacts = (report: SnapshotReport): SnapshotFacts => ({
  activeMatchesPromotion: report.activeMatchesPromotion,
  activeRows: report.active.rows,
  state: report.state,
});

export const exportDeps = async (
  context: ApiExtensionContext,
): Promise<ExportDeps> => ({
  coordination: async () =>
    coordinationFacts(
      await statusAction(coordinationContext(context.database)),
    ),
  now: () => performance.now(),
  reader: await itemsReader(context),
  snapshot: async () =>
    snapshotFacts(
      await snapshotReport(snapshotStore(sqlDatabase(context.database))),
    ),
});
