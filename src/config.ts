import path from 'node:path';
import { z } from 'zod';

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

export const loadConfig = (
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): CliConfig => {
  const parsedArguments = argumentsSchema.parse(arguments_);
  const dryRun = parsedArguments.includes('--dry-run');
  const workbookPath = path.resolve(
    environment['WORKBOOK_PATH'] ?? 'finki-hub.xlsx',
  );

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
