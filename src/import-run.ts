import type { DirectusRequest } from './directus-request.js';

import { type DirectusConfig, loadImportConfig } from './config.js';
import { checkSummary, refusalCount, refusalLines } from './import-report.js';
import { type ImportIo, importWorkbook } from './import-workbook.js';
import { type ImportPlan, planImport } from './import/plan.js';
import {
  type CommandName,
  exitCodes,
  outcomeLine,
  reportFailure,
} from './lifecycle.js';
import { countText, printSummary } from './text.js';
import { loadWorkbook, type WorkbookContent } from './workbook.js';

type ImportCliIo = ImportIo & {
  readonly createRequest: (config: DirectusConfig) => DirectusRequest;
  readonly stderr: (line: string) => void;
  readonly stdout: (line: string) => void;
};

// Everything that blocks the import, on stderr: the header with the number
// of cases, then one line per value no column can hold and per blocking
// case, each with its code and its sheet and row.
const reportBlocked = (
  command: CommandName,
  {
    plan,
    workbook,
  }: { readonly plan: ImportPlan; readonly workbook: WorkbookContent },
  stderr: (line: string) => void,
): void => {
  stderr(
    outcomeLine(
      command,
      'blocked',
      countText(refusalCount(plan), 'case', 'cases'),
    ),
  );
  for (const line of refusalLines(plan, workbook)) {
    stderr(line);
  }
};

// `npm run import [--dry-run]`: returns the exit code (see exitCodes) and
// prints aggregate counts and the places of the rule fixes only, never a
// value. Both commands read the workbook and run the same check before
// Directus is contacted: a workbook that cannot be read fails (exit 1);
// every value no column can hold and every case the import cannot write
// as the workbook states it block (exit 3), all named by code, sheet and
// row on stderr in one run. Only an unblocked import contacts Directus.
// The dry run names itself in its blocked header
// (`Import dry run blocked: <n> cases`); every other first line starts
// with `Import <outcome>:` in both modes.
export const runImportCli = async (
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  io: ImportCliIo,
): Promise<number> => {
  try {
    const config = loadImportConfig(arguments_, environment);
    const workbook = await loadWorkbook(config.workbookPath);
    const plan = planImport(workbook);
    const summary = checkSummary(plan, workbook);
    const dryRun = config.directus === null;
    if (dryRun) {
      printSummary(io, { mode: 'dry-run', ...summary });
    }
    if (refusalCount(plan) > 0) {
      if (!dryRun) {
        printSummary(io, { mode: 'import', ...summary });
      }
      reportBlocked(
        dryRun ? 'Import dry run' : 'Import',
        { plan, workbook },
        io.stderr,
      );
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
    printSummary(io, { mode: 'import', ...summary, ...imported });
    return exitCodes.ok;
  } catch (error) {
    return reportFailure('Import', error, io);
  }
};
