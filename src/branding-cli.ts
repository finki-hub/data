import { runBrandingCli } from './branding-run.js';
import { createDirectusRequest } from './directus-request.js';

process.exitCode = await runBrandingCli(process.argv.slice(2), process.env, {
  createRequest: createDirectusRequest,
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
});
