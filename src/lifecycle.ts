import { DataOperationsUnavailableError } from './data-model/constraints.js';
import {
  CollectionLimitError,
  SchemaRefusalError,
} from './data-model/install.js';
import { IncompleteFlowError } from './flows/install-flows.js';
import { ImportInterruptedError } from './import-interruption.js';
import { ExistingDataError } from './import-state.js';
import { SetupConfigError } from './setup-config.js';
import { errorText } from './text.js';

// Exit codes of the commands (`npm run setup`, `npm run import`, its dry
// run, `npm run brand` and `npm run compare:live`), each with the outcome
// word its first line carries: 0 succeeded; 1 failed, before any row was
// written; 2 refused, the invocation or the project in a state the command
// does not accept, before any record was written; 3 blocked (import and
// live check only), workbook cases named by sheet and row, before
// Directus or the live files are contacted; 4 interrupted (import only),
// after rows were written. README lists what to do.
export const exitCodes = {
  blocked: 3,
  failed: 1,
  interrupted: 4,
  ok: 0,
  refused: 2,
} as const;

// The command a first line names; `Import dry run` heads the dry run's
// blocked header only.
export type CommandName =
  'Branding' | 'Import' | 'Import dry run' | 'Live check' | 'Setup';

type Outcome = 'blocked' | 'failed' | 'interrupted' | 'refused' | 'succeeded';

// The first line of a command's outcome: `<Command> <outcome>[: <reason>]`.
export const outcomeLine = (
  command: CommandName,
  outcome: Outcome,
  reason?: string,
): string =>
  reason === undefined
    ? `${command} ${outcome}`
    : `${command} ${outcome}: ${reason}`;

const refusals = [
  CollectionLimitError,
  DataOperationsUnavailableError,
  ExistingDataError,
  IncompleteFlowError,
  SchemaRefusalError,
  SetupConfigError,
] as const;

// An incompatible state: no target named, a populated project offered to
// the fresh importer, existing definitions the model cannot carry, a
// half-installed Flow, or a Directus without the data-operations bundle.
export const isRefusal = (error: unknown): boolean =>
  refusals.some((refusal) => error instanceof refusal);

const endingOf = (
  error: unknown,
): { readonly code: number; readonly outcome: Outcome } => {
  if (isRefusal(error)) {
    return { code: exitCodes.refused, outcome: 'refused' };
  }
  return error instanceof ImportInterruptedError
    ? { code: exitCodes.interrupted, outcome: 'interrupted' }
    : { code: exitCodes.failed, outcome: 'failed' };
};

type StderrIo = { readonly stderr: (line: string) => void };

// Reports the error a command stopped on and answers its exit code: the
// outcome line with the error on one line, then, for a schema refusal,
// one `- ` line per refused definition.
export const reportFailure = (
  command: CommandName,
  error: unknown,
  io: StderrIo,
): number => {
  const { code, outcome } = endingOf(error);
  io.stderr(outcomeLine(command, outcome, errorText(error)));
  if (error instanceof SchemaRefusalError) {
    for (const { reason } of error.refusals) {
      io.stderr(`- ${reason}`);
    }
  }
  return code;
};
