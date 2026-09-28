import path from 'node:path';
import { z } from 'zod';

import { loadTargetConfig, SetupConfigError } from './setup-config.js';

export type DirectusConfig = {
  readonly token: string;
  readonly url: URL;
};

type ImportConfig = {
  // null for --dry-run, which never contacts Directus.
  readonly directus: DirectusConfig | null;
  readonly workbookPath: string;
};

const importArgumentsSchema = z.array(z.enum(['--dry-run'])).max(1);
const brandingEnvironmentSchema = z.object({
  DIRECTUS_TOKEN: z.string().min(1),
  DIRECTUS_URL: z.url(),
});

// The branding command's configuration. It takes no argument; its target
// comes from the environment, which npm run brand completes from .env.
export const loadBrandingConfig = (
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): DirectusConfig => {
  if (arguments_.length > 0) {
    throw new Error(
      `npm run brand takes no argument (got ${arguments_.join(' ')}).`,
    );
  }
  const parsed = brandingEnvironmentSchema.parse({
    DIRECTUS_TOKEN:
      environment['DIRECTUS_TOKEN'] ?? environment['DIRECTUS_ADMIN_TOKEN'],
    DIRECTUS_URL: environment['DIRECTUS_URL'] ?? 'http://localhost:8055',
  });
  return {
    token: parsed.DIRECTUS_TOKEN,
    url: new URL(parsed.DIRECTUS_URL),
  };
};

// The workbook import's configuration. `--dry-run` only reads the workbook
// and never needs credentials; a real import names its target explicitly,
// like setup, with no default URL.
export const loadImportConfig = (
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): ImportConfig => {
  const parsedArguments = importArgumentsSchema.safeParse(arguments_);
  if (!parsedArguments.success) {
    throw new SetupConfigError(
      `npm run import takes no argument except --dry-run (got ${arguments_.join(' ')}).`,
    );
  }
  return {
    directus: parsedArguments.data.includes('--dry-run')
      ? null
      : loadTargetConfig(environment, {
          name: 'The import',
          purpose: 'import the workbook into',
        }),
    workbookPath: path.resolve(
      environment['WORKBOOK_PATH'] ?? 'finki-hub.xlsx',
    ),
  };
};
