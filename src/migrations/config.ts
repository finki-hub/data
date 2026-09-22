import path from 'node:path';

import type { DirectusConfig } from '../config.js';

export class MigrationConfigError extends Error {
  public override readonly name = 'MigrationConfigError';
}

export type MigrationMode = 'apply' | 'dry-run';

export type MigrationConfig = {
  readonly backupReceipt: null | string;
  readonly directus: DirectusConfig;
  readonly mode: MigrationMode;
  readonly report: string;
  readonly resume: boolean;
};

const valueFlags = ['--report', '--backup-receipt'] as const;
const booleanFlags = ['--dry-run', '--apply', '--resume'] as const;

const present = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value;

const parseArguments = (arguments_: readonly string[]) => {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? '';
    if ((booleanFlags as readonly string[]).includes(argument)) {
      flags.add(argument);
      continue;
    }
    if ((valueFlags as readonly string[]).includes(argument)) {
      const value = present(arguments_[index + 1]);
      if (value === undefined || value.startsWith('--')) {
        throw new MigrationConfigError(`${argument} needs a path argument.`);
      }
      values.set(argument, value);
      index += 1;
      continue;
    }
    throw new MigrationConfigError(`Unknown argument ${argument}.`);
  }
  return { flags, values };
};

const loadDirectus = (
  environment: Readonly<Record<string, string | undefined>>,
): DirectusConfig => {
  const rawUrl = present(environment['DIRECTUS_URL']);
  if (rawUrl === undefined) {
    throw new MigrationConfigError(
      'DIRECTUS_URL is not set. The migration never assumes a default project and does not read .env: pass DIRECTUS_URL and DIRECTUS_TOKEN on the command line for the project you intend to inspect.',
    );
  }
  const token =
    present(environment['DIRECTUS_TOKEN']) ??
    present(environment['DIRECTUS_ADMIN_TOKEN']);
  if (token === undefined) {
    throw new MigrationConfigError(
      'DIRECTUS_TOKEN (or DIRECTUS_ADMIN_TOKEN) is not set. The migration does not read .env: pass a static administrator token of the target project on the command line.',
    );
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new MigrationConfigError(
      `DIRECTUS_URL "${rawUrl}" is not an absolute URL such as http://127.0.0.1:18055.`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new MigrationConfigError('DIRECTUS_URL must use http or https.');
  }
  return { token, url };
};

// `--dry-run --report <private path>` or `--apply --report <private path>
// --backup-receipt <private path> [--resume]`, with the target named
// explicitly in the environment.
export const loadMigrationConfig = (
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): MigrationConfig => {
  const { flags, values } = parseArguments(arguments_);
  const dryRun = flags.has('--dry-run');
  const apply = flags.has('--apply');
  if (dryRun === apply) {
    throw new MigrationConfigError('Pass exactly one of --dry-run or --apply.');
  }
  const report = values.get('--report');
  if (report === undefined) {
    throw new MigrationConfigError(
      '--report <private path> is required: the detailed report carries labels under review and is only ever written to the path you name explicitly.',
    );
  }
  const backupReceipt = values.get('--backup-receipt');
  if (apply && backupReceipt === undefined) {
    throw new MigrationConfigError(
      '--apply requires --backup-receipt <private path>: a receipt of a backup taken against the same source fingerprint as the report.',
    );
  }
  if (dryRun && backupReceipt !== undefined) {
    throw new MigrationConfigError('--backup-receipt only applies to --apply.');
  }
  if (dryRun && flags.has('--resume')) {
    throw new MigrationConfigError('--resume only applies to --apply.');
  }
  return {
    backupReceipt:
      backupReceipt === undefined ? null : path.resolve(backupReceipt),
    directus: loadDirectus(environment),
    mode: apply ? 'apply' : 'dry-run',
    report: path.resolve(report),
    resume: flags.has('--resume'),
  };
};
