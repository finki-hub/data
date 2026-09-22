import type { DirectusConfig } from './config.js';

export class SetupConfigError extends Error {
  public override readonly name = 'SetupConfigError';
}

const present = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value;

// Reads the explicit setup target. Unlike the importer there is no default
// URL: schema setup mutates whichever project it is pointed at, so the
// operator must name it.
export const loadSetupConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): DirectusConfig => {
  const rawUrl = present(environment['DIRECTUS_URL']);
  if (rawUrl === undefined) {
    throw new SetupConfigError(
      'DIRECTUS_URL is not set. Setup never assumes a default project and does not read .env: pass DIRECTUS_URL (for example http://127.0.0.1:18055) and DIRECTUS_TOKEN on the command line for the project you intend to set up.',
    );
  }
  const token =
    present(environment['DIRECTUS_TOKEN']) ??
    present(environment['DIRECTUS_ADMIN_TOKEN']);
  if (token === undefined) {
    throw new SetupConfigError(
      'DIRECTUS_TOKEN (or DIRECTUS_ADMIN_TOKEN) is not set. Setup does not read .env: pass a static administrator token of the target project on the command line.',
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
