import type { DirectusModeRequest } from './directus-request.js';

import { type DirectusConfig, loadImportConfig } from './config.js';
import { type ImportIo, importWorkbook } from './directus.js';
import { ImportInterruptedError } from './import-interruption.js';
import { exitCodes, isRefusal } from './lifecycle.js';
import { previewBlockers } from './migrations/workbook-adapter.js';
import { WorkbookDataError } from './workbook-values.js';
import {
  assertStorable,
  countMigrationData,
  loadWorkbook,
} from './workbook.js';

export type ImportCliIo = ImportIo & {
  readonly createRequest: (config: DirectusConfig) => DirectusModeRequest;
  readonly stderr: (line: string) => void;
  readonly stdout: (line: string) => void;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// The message as a sentence, so a remark can follow it.
const sentence = (message: string): string =>
  message.endsWith('.') ? message : `${message}.`;

// `npm run import [--dry-run]`: returns the exit code (see exitCodes) and
// prints aggregate counts only. The workbook is read and checked before
// Directus is contacted, so a bad workbook, like a dry-run, never reaches
// it; the dry run also previews the conversion blockers the import would
// meet.
export const runImportCli = async (
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  io: ImportCliIo,
): Promise<number> => {
  try {
    const config = loadImportConfig(arguments_, environment);
    const workbook = await loadWorkbook(config.workbookPath);
    assertStorable(workbook.data);
    if (config.directus === null) {
      io.stdout(JSON.stringify(countMigrationData(workbook.data), null, 2));
      const blockers = previewBlockers(workbook);
      if (Object.keys(blockers).length === 0) {
        return exitCodes.ok;
      }
      io.stderr(
        `Dry run: the relational conversion of this workbook would be blocked by ${JSON.stringify(blockers)}. npm run import would write the rows, skip the conversion and exit 3, leaving a populated project to finish with npm run migrate. Correct these ambiguous relationships in the workbook first, or plan to resolve them in Studio after the import.`,
      );
      return exitCodes.blocked;
    }
    const summary = await importWorkbook(
      io.createRequest(config.directus),
      workbook,
      io,
    );
    io.stdout(JSON.stringify({ mode: 'import', ...summary }));
    if (summary.conversion.status === 'blocked') {
      io.stderr(
        `Import incomplete: the workbook rows were imported and the checkpoint derivation ran, but the relational conversion is blocked by ${JSON.stringify(summary.conversion.blockers)}. Resolve these ambiguous relationships in Studio, then finish with npm run migrate -- --dry-run --report <private path> and --apply.`,
      );
      return exitCodes.blocked;
    }
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
