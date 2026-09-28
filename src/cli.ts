import { createDirectusRequest } from './directus-request.js';
import { runImportCli } from './import-run.js';

process.exitCode = await runImportCli(process.argv.slice(2), process.env, {
  createRequest: createDirectusRequest,
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
});
