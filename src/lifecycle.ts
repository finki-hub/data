import { DataOperationsUnavailableError } from './data-model/constraints.js';
import {
  CollectionLimitError,
  SchemaRefusalError,
} from './data-model/install.js';
import { IncompleteFlowError } from './flows/install-flows.js';
import { ExistingDataError } from './import-state.js';
import { LegacyFlowsError } from './legacy-flows.js';
import { SetupConfigError } from './setup-config.js';

// Exit codes of the lifecycle commands (`npm run setup`, `npm run import`):
// 0 done; 1 failed before any row was written (an unexpected error, which
// a rerun may retry, or a workbook that cannot be read or stored); 2
// refused because the invocation or the project is in a state the command
// does not accept, before any record was written; 3 (import only) the
// relational conversion is blocked until the reported findings are
// resolved: the rows were imported, or with --dry-run would be; 4 (import
// only) the import stopped after it began writing rows, and its message
// names what was stored and how to finish.
export const exitCodes = {
  blocked: 3,
  failed: 1,
  interrupted: 4,
  ok: 0,
  refused: 2,
} as const;

const refusals = [
  CollectionLimitError,
  DataOperationsUnavailableError,
  ExistingDataError,
  IncompleteFlowError,
  LegacyFlowsError,
  SchemaRefusalError,
  SetupConfigError,
] as const;

// An incompatible state: no target named, a populated project (or one
// holding checkpoint Flows of its own) offered to the fresh importer,
// existing definitions the model cannot adopt, a half-installed Flow, or a
// Directus without the data-operations bundle.
export const isRefusal = (error: unknown): boolean =>
  refusals.some((refusal) => error instanceof refusal);
