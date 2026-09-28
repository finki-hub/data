import type { DirectusConfig } from './config.js';
import type { DirectusRequest } from './directus-request.js';

import { SchemaRefusalError } from './data-model/install.js';
import { exitCodes, isRefusal } from './lifecycle.js';
import { loadSetupConfig } from './setup-config.js';
import { runSetup } from './setup.js';

type SetupCliIo = {
  readonly createRequest: (config: DirectusConfig) => DirectusRequest;
  // `npm run setup` itself unless a test substitutes a stand-in.
  readonly setup?: (request: DirectusRequest) => Promise<unknown>;
  readonly stderr: (line: string) => void;
  readonly stdout: (line: string) => void;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// `npm run setup`: returns the exit code (see exitCodes). An incompatible
// state (no explicit target, definitions the model cannot adopt, a
// half-installed Flow, a Directus without the data-operations bundle) is
// refused with 2 and "Setup refused:"; any other error fails with 1 and
// "Setup failed:". A schema refusal also prints the plan's summary.
export const runSetupCli = async (
  environment: Readonly<Record<string, string | undefined>>,
  io: SetupCliIo,
): Promise<number> => {
  try {
    const request = io.createRequest(loadSetupConfig(environment));
    const summary = await (io.setup ?? runSetup)(request);
    io.stdout(JSON.stringify(summary, null, 2));
    return exitCodes.ok;
  } catch (error) {
    if (error instanceof SchemaRefusalError) {
      io.stdout(JSON.stringify(error.summary, null, 2));
    }
    const refused = isRefusal(error);
    io.stderr(`Setup ${refused ? 'refused' : 'failed'}: ${messageOf(error)}`);
    return refused ? exitCodes.refused : exitCodes.failed;
  }
};
