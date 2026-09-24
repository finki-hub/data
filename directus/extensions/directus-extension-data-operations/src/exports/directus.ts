import type { OperationContext } from '@directus/types';

import type { SourceReader } from './engine.js';
import type { ExportDeps } from './prepare.js';

import { coordinationContext, sqlDatabase } from '../coordinate.js';
import { calculationDomains } from '../coordination/domains.js';
import { statusAction, type StatusReport } from '../coordination/status.js';
import { snapshotReport, type SnapshotReport } from '../snapshot/report.js';
import { snapshotStore } from '../snapshot/sql-port.js';
import {
  type CoordinationFacts,
  type SnapshotFacts,
} from './readiness-facts.js';

// The Directus side of the export operation: native reads through the
// ItemsService, the coordinator status and the snapshot status.

// Reads as the system (accountability null): the operation checks the
// caller's administrator flag itself before anything else, and every read
// names its fields explicitly, so no private column is ever selected.
// Events are not emitted and the whole result is read at once; an
// aggregate read answers its one count row.
export const itemsReader = async (
  context: OperationContext,
): Promise<SourceReader> => {
  const schema = await context.getSchema({ database: context.database });
  return (read) => {
    const items = new context.services.ItemsService(read.collection, {
      accountability: null,
      knex: context.database,
      schema,
    });
    const filter = read.filter === undefined ? {} : { filter: read.filter };
    return items.readByQuery(
      read.aggregate === undefined
        ? {
            fields: [...read.fields],
            ...filter,
            limit: -1,
            sort: [...read.sort],
          }
        : { aggregate: { [read.aggregate]: [...read.fields] }, ...filter },
      { emitEvents: false },
    );
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
  context: OperationContext,
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
