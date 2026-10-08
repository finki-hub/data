import { runLiveCheck } from './live-check/run.js';

process.exitCode = await runLiveCheck(process.argv.slice(2), process.env, {
  fetch,
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
});
