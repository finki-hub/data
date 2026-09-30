import type { DirectusConfig } from './config.js';
import type { DirectusRequest } from './directus-request.js';

import { SchemaRefusalError } from './data-model/install.js';
import { exitCodes, reportFailure } from './lifecycle.js';
import { loadSetupConfig } from './setup-config.js';
import { runSetup } from './setup.js';
import { printSummary } from './text.js';

type SetupCliIo = {
  readonly createRequest: (config: DirectusConfig) => DirectusRequest;
  // `npm run setup` itself unless a test substitutes a stand-in.
  readonly setup?: (request: DirectusRequest) => Promise<unknown>;
  readonly stderr: (line: string) => void;
  readonly stdout: (line: string) => void;
};

// `npm run setup`: returns the exit code (see exitCodes). An incompatible
// state (no explicit target, definitions the model cannot adopt, a
// half-installed Flow, a Directus without the data-operations bundle) is
// refused with 2 and a "Setup refused:" line; any other error fails with
// 1 and a "Setup failed:" line. A schema refusal also prints the plan's
// summary on stdout and one stderr line per refused definition.
export const runSetupCli = async (
  environment: Readonly<Record<string, string | undefined>>,
  io: SetupCliIo,
): Promise<number> => {
  try {
    const request = io.createRequest(loadSetupConfig(environment));
    printSummary(io, await (io.setup ?? runSetup)(request));
    return exitCodes.ok;
  } catch (error) {
    if (error instanceof SchemaRefusalError) {
      printSummary(io, error.summary);
    }
    return reportFailure('Setup', error, io);
  }
};
