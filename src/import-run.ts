import type { DirectusRequest } from './directus-request.js';

import { type DirectusConfig, loadImportConfig } from './config.js';
import { type ImportIo, importWorkbook } from './directus.js';
import { ImportInterruptedError } from './import-interruption.js';
import { checkSummary, refusalCount, refusalLines } from './import-report.js';
import { exitCodes, isRefusal } from './lifecycle.js';
import { type ImportPlan, planImport } from './migrations/plan.js';
import { WorkbookDataError } from './workbook-values.js';
import { loadWorkbook, type WorkbookPlaces } from './workbook.js';

export type ImportCliIo = ImportIo & {
  readonly createRequest: (config: DirectusConfig) => DirectusRequest;
  readonly stderr: (line: string) => void;
  readonly stdout: (line: string) => void;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// The message as a sentence, so a remark can follow it.
const sentence = (message: string): string =>
  message.endsWith('.') ? message : `${message}.`;

// Everything that refuses the import on stderr: the values no column can
// hold, each named by sheet, row and column, and the blocking cases, one
// line per code, each case named by its sheet and rows.
const reportBlocked = (
  {
    dryRun,
    places,
    plan,
  }: {
    readonly dryRun: boolean;
    readonly places: WorkbookPlaces;
    readonly plan: ImportPlan;
  },
  stderr: (line: string) => void,
): void => {
  stderr(
    `${dryRun ? 'Dry run: npm run import would refuse this workbook' : 'Import blocked'}: correct these ${String(refusalCount(plan))} case(s) in the workbook, then import again; nothing was sent to Directus.`,
  );
  for (const line of refusalLines(plan, places)) {
    stderr(line);
  }
};

// `npm run import [--dry-run]`: returns the exit code (see exitCodes) and
// prints aggregate counts only. Both commands read the workbook and run
// the same check before Directus is contacted: a workbook that cannot be
// read fails (exit 1); every value no column can hold and every case the
// import cannot write as the workbook states it block (exit 3), all named
// by sheet and row on stderr in one run. Only an unblocked import
// contacts Directus.
export const runImportCli = async (
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  io: ImportCliIo,
): Promise<number> => {
  try {
    const config = loadImportConfig(arguments_, environment);
    const workbook = await loadWorkbook(config.workbookPath);
    const plan = planImport(workbook);
    const summary = checkSummary(plan);
    const dryRun = config.directus === null;
    if (dryRun) {
      io.stdout(JSON.stringify({ mode: 'dry-run', ...summary }, null, 2));
    }
    if (refusalCount(plan) > 0) {
      if (!dryRun) {
        io.stdout(JSON.stringify({ mode: 'import', ...summary }));
      }
      reportBlocked({ dryRun, places: workbook.places, plan }, io.stderr);
      return exitCodes.blocked;
    }
    if (config.directus === null) {
      return exitCodes.ok;
    }
    const imported = await importWorkbook(
      io.createRequest(config.directus),
      plan.collections,
      io,
    );
    io.stdout(JSON.stringify({ mode: 'import', ...summary, ...imported }));
    return exitCodes.ok;
  } catch (error) {
    if (isRefusal(error)) {
      io.stderr(`Import refused: ${messageOf(error)}`);
      return exitCodes.refused;
    }
    if (error instanceof ImportInterruptedError) {
      io.stderr(`Import interrupted: ${error.message}`);
      return exitCodes.interrupted;
    }
    io.stderr(
      error instanceof WorkbookDataError
        ? `Import failed: ${sentence(messageOf(error))} Nothing was sent to Directus.`
        : `Import failed: ${messageOf(error)}`,
    );
    return exitCodes.failed;
  }
};
