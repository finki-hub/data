import type { DirectusConfig } from './config.js';

// A lifecycle command (`npm run setup`, `npm run import`) was not told which
// project to change.
export class SetupConfigError extends Error {
  public override readonly name = 'SetupConfigError';
}

export type TargetCommand = {
  // The command as the sentence subject, e.g. "Setup".
  readonly name: string;
  // What the command does to the project, e.g. "set up".
  readonly purpose: string;
};

const present = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value;

// Reads the explicit target of a lifecycle command. There is no default
// URL and no .env: the command mutates whichever project it is pointed at,
// so the operator must name it on the invocation.
export const loadTargetConfig = (
  environment: Readonly<Record<string, string | undefined>>,
  command: TargetCommand,
): DirectusConfig => {
  const rawUrl = present(environment['DIRECTUS_URL']);
  if (rawUrl === undefined) {
    throw new SetupConfigError(
      `DIRECTUS_URL is not set. ${command.name} never assumes a default project and does not read .env: pass DIRECTUS_URL (for example http://127.0.0.1:18055) and DIRECTUS_TOKEN on the command line for the project you intend to ${command.purpose}.`,
    );
  }
  const token =
    present(environment['DIRECTUS_TOKEN']) ??
    present(environment['DIRECTUS_ADMIN_TOKEN']);
  if (token === undefined) {
    throw new SetupConfigError(
      `DIRECTUS_TOKEN (or DIRECTUS_ADMIN_TOKEN) is not set. ${command.name} does not read .env: pass a static administrator token of the target project on the command line.`,
    );
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SetupConfigError(
      `DIRECTUS_URL "${rawUrl}" is not an absolute URL such as http://127.0.0.1:18055.`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SetupConfigError('DIRECTUS_URL must use http or https.');
  }
  return { token, url };
};

export const loadSetupConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): DirectusConfig =>
  loadTargetConfig(environment, { name: 'Setup', purpose: 'set up' });
