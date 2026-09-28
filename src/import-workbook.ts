import type { DirectusRequest } from './directus-request.js';
import type { PlannedCollection } from './import/planned.js';

import { ImportInterruptedError } from './import-interruption.js';
import { countApplicationRecords, ExistingDataError } from './import-state.js';
import { defaultBatchSize } from './import/batches.js';
import { writePlan } from './import/write.js';
import { runSetup } from './setup.js';

// The aggregate summary `npm run setup` prints.
export type SetupReport = Readonly<Record<string, unknown>>;

export type ImportIo = {
  // Rows per POST; the importer's bound of 250 unless a test lowers it.
  readonly batchSize?: number;
  // `npm run setup`; tests substitute a stand-in for the schema installer.
  readonly setup?: (request: DirectusRequest) => Promise<SetupReport>;
};

type ImportSummary = {
  readonly rows: Readonly<Record<string, number>>;
  readonly setup: SetupReport;
};

// The one-time workbook import of a checked plan (import/plan.ts). It
// refuses, before any write, a populated project (see
// countApplicationRecords); runs setup (so an import into an empty project
// equals setup plus import); then writes the planned relational rows in
// dependency order, each reference resolved through the ids Directus
// answered. It runs no Flow and publishes nothing. A failure after the
// first write raises ImportInterruptedError: the project then holds part
// of the import, and the remedy is a fresh project. Only the lifecycle
// command (`npm run import`, through runImportCli) calls it, once the
// check found no blocking case.
export const importWorkbook = async (
  request: DirectusRequest,
  collections: readonly PlannedCollection[],
  io: ImportIo,
): Promise<ImportSummary> => {
  const records = await countApplicationRecords(request);
  if (Object.keys(records).length > 0) {
    throw new ExistingDataError(records);
  }
  const setup = await (io.setup ?? runSetup)(request);
  const total = collections.reduce((sum, { rows }) => sum + rows.length, 0);
  let confirmed = 0;
  try {
    const rows = await writePlan(request, collections, {
      batchSize: io.batchSize ?? defaultBatchSize,
      confirmed: (count) => {
        confirmed += count;
      },
    });
    return { rows, setup };
  } catch (error) {
    throw new ImportInterruptedError({ confirmed, total }, { cause: error });
  }
};
