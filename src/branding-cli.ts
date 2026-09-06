import { loadConfig } from './config.js';
import { DirectusClient } from './directus.js';

try {
  const config = loadConfig(process.argv.slice(2), process.env);
  if (config.directus === null) {
    process.stderr.write(
      'Branding does not support --dry-run. Run npm run brand to apply it.\n',
    );
    process.exitCode = 1;
  } else {
    await new DirectusClient(config.directus).applyBranding();
    process.stdout.write(
      'Applied FINKI Hub branding. Refresh Directus Studio to see it.\n',
    );
  }
} catch (error) {
  process.stderr.write(
    `Branding failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
