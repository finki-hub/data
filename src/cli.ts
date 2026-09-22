import { randomUUID } from 'node:crypto';

import { createDirectusRequest } from './directus-request.js';
import { runImportCli } from './import-run.js';

// Node 24 ships no Temporal, so the ledger timestamps come from Date here.
const now = (): string => new Date().toISOString();

process.exitCode = await runImportCli(process.argv.slice(2), process.env, {
  createRequest: createDirectusRequest,
  now,
  runToken: randomUUID,
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
});
