import { applyBranding } from './branding.js';
import { loadBrandingConfig } from './config.js';
import { createDirectusRequest } from './directus-request.js';

try {
  const config = loadBrandingConfig(process.argv.slice(2), process.env);
  await applyBranding(createDirectusRequest(config));
  process.stdout.write(
    'Applied FINKI Hub branding. Refresh Directus Studio to see it.\n',
  );
} catch (error) {
  process.stderr.write(
    `Branding failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
