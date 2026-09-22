import { createDirectusRequest } from './directus-request.js';
import { runSetupCli } from './setup-run.js';

process.exitCode = await runSetupCli(process.env, {
  createRequest: createDirectusRequest,
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
});
