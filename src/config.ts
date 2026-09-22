import path from 'node:path';
import { z } from 'zod';

import { loadTargetConfig, SetupConfigError } from './setup-config.js';

const argumentsSchema = z.array(z.enum(['--dry-run'])).max(1);
const directusConfigSchema = z.object({
  DIRECTUS_TOKEN: z.string().min(1),
  DIRECTUS_URL: z.url(),
});

export type CliConfig = {
  readonly directus: DirectusConfig | null;
  readonly dryRun: boolean;
  readonly workbookPath: string;
};

export type DirectusConfig = {
  readonly token: string;
  readonly url: URL;
};

const workbookPathOf = (
  environment: Readonly<Record<string, string | undefined>>,
): string => path.resolve(environment['WORKBOOK_PATH'] ?? 'finki-hub.xlsx');

// The branding command's configuration: .env supplies the target.
export const loadConfig = (
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): CliConfig => {
  const parsedArguments = argumentsSchema.parse(arguments_);
  const dryRun = parsedArguments.includes('--dry-run');
  const workbookPath = workbookPathOf(environment);

  if (dryRun) {
    return { directus: null, dryRun, workbookPath };
  }

  const parsedEnvironment = directusConfigSchema.parse({
    DIRECTUS_TOKEN:
      environment['DIRECTUS_TOKEN'] ?? environment['DIRECTUS_ADMIN_TOKEN'],
    DIRECTUS_URL: environment['DIRECTUS_URL'] ?? 'http://localhost:8055',
  });

  return {
    directus: {
      token: parsedEnvironment.DIRECTUS_TOKEN,
      url: new URL(parsedEnvironment.DIRECTUS_URL),
    },
    dryRun,
    workbookPath,
  };
};

// The workbook import's configuration. `--dry-run` only reads the workbook
// and never needs credentials; a real import names its target explicitly,
// like setup and the migration, with no default URL.
export const loadImportConfig = (
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): CliConfig => {
  const parsedArguments = argumentsSchema.safeParse(arguments_);
  if (!parsedArguments.success) {
    throw new SetupConfigError(
      `npm run import takes no argument except --dry-run (got ${arguments_.join(' ')}).`,
    );
  }
  const dryRun = parsedArguments.data.includes('--dry-run');
  return {
    directus: dryRun
      ? null
      : loadTargetConfig(environment, {
          name: 'The import',
          purpose: 'import the workbook into',
        }),
    dryRun,
    workbookPath: workbookPathOf(environment),
  };
};
