import type { DirectusConfig } from './config.js';

// A command was not told which project to change, or was invoked with an
// argument it does not accept.
export class SetupConfigError extends Error {
  public override readonly name = 'SetupConfigError';
}

// Where a command's target comes from. Setup and the import read the
// command line only: no .env and no default URL, so each names the project
// it changes. `npm run brand` reads the environment its npm script
// completes from .env, with a local default URL.
export type TargetSource = {
  readonly defaultUrl: null | string;
  readonly readsEnvFile: boolean;
};

const commandLine: TargetSource = { defaultUrl: null, readsEnvFile: false };

const present = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value;

// A variable a command needs is not set; setup and the import add that
// they read no .env.
const notSet = (variable: string, source: TargetSource): SetupConfigError =>
  new SetupConfigError(
    source.readsEnvFile
      ? `${variable} not set`
      : `${variable} not set (.env not read)`,
  );

// Reads the explicit target of a command: `<VARIABLE> <condition>[: "<value>"]`
// when a variable is missing or unusable.
export const loadTargetConfig = (
  environment: Readonly<Record<string, string | undefined>>,
  source: TargetSource = commandLine,
): DirectusConfig => {
  const rawUrl =
    present(environment['DIRECTUS_URL']) ?? source.defaultUrl ?? undefined;
  if (rawUrl === undefined) {
    throw notSet('DIRECTUS_URL', source);
  }
  const token =
    present(environment['DIRECTUS_TOKEN']) ??
    present(environment['DIRECTUS_ADMIN_TOKEN']);
  if (token === undefined) {
    throw notSet('DIRECTUS_TOKEN or DIRECTUS_ADMIN_TOKEN', source);
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SetupConfigError(
      `DIRECTUS_URL not an absolute URL: ${JSON.stringify(rawUrl)}`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SetupConfigError(
      `DIRECTUS_URL protocol not http or https: ${JSON.stringify(url.protocol)}`,
    );
  }
  return { token, url };
};

export const loadSetupConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): DirectusConfig => loadTargetConfig(environment);
