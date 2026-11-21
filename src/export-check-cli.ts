import { createDirectusRequest } from './directus-request.js';
import { runExportCheck } from './export-check.js';
import { exitCodes } from './lifecycle.js';
import { loadTargetConfig } from './setup-config.js';

// npm run check:exports: the export check against DIRECTUS_URL, read with
// DIRECTUS_TOKEN or DIRECTUS_ADMIN_TOKEN. Exits 1 when a file is refused.
try {
  const config = loadTargetConfig(process.env);
  const builds = await runExportCheck({
    liveFile: async (filename) => {
      const response = await fetch(new URL(`catalog/${filename}`, config.url));
      return response.ok ? response.text() : null;
    },
    request: createDirectusRequest(config),
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
  });
  process.exitCode = builds ? exitCodes.ok : exitCodes.failed;
} catch (error) {
  process.stderr.write(
    `Export check failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = exitCodes.failed;
}
