import type { DirectusRequest } from './directus-request.js';

import { applyBranding } from './branding.js';
import { type DirectusConfig, loadBrandingConfig } from './config.js';
import { exitCodes, outcomeLine, reportFailure } from './lifecycle.js';

type BrandingCliIo = {
  readonly createRequest: (config: DirectusConfig) => DirectusRequest;
  readonly stderr: (line: string) => void;
  readonly stdout: (line: string) => void;
};

// `npm run brand`: returns the exit code (see exitCodes). An unexpected
// argument or an unusable target is refused with 2 and a "Branding
// refused:" line; any other error fails with 1 and a "Branding failed:"
// line; success prints "Branding succeeded" on stdout.
export const runBrandingCli = async (
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  io: BrandingCliIo,
): Promise<number> => {
  try {
    const config = loadBrandingConfig(arguments_, environment);
    await applyBranding(io.createRequest(config));
    io.stdout(outcomeLine('Branding', 'succeeded'));
    return exitCodes.ok;
  } catch (error) {
    return reportFailure('Branding', error, io);
  }
};
