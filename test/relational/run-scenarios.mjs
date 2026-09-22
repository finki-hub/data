// `npm run test:relational [-- --scenario <name>]`: runs the fixture suites
// test/relational/*.integration.mjs one after another, or only
// test/relational/<name>.integration.mjs when a scenario is named. The
// suites read the explicit target from DIRECTUS_SEARCH_TEST_* variables.
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const directory = import.meta.dirname;
const suffix = '.integration.mjs';
const flag = '--scenario';

const scenarioOf = (argv) => {
  const index = argv.findIndex(
    (value) => value === flag || value.startsWith(`${flag}=`),
  );
  if (index === -1) return null;
  const argument = argv[index] ?? '';
  return argument.includes('=')
    ? argument.slice(flag.length + 1)
    : (argv[index + 1] ?? '');
};

const entries = await readdir(directory);
const suites = entries.filter((name) => name.endsWith(suffix)).toSorted();
const scenario = scenarioOf(process.argv.slice(2));
const selected =
  scenario === null
    ? suites
    : suites.filter((name) => name === `${scenario}${suffix}`);

if (selected.length === 0) {
  process.stderr.write(
    `Unknown scenario "${scenario}". Known: ${suites.map((name) => name.slice(0, -suffix.length)).join(', ')}.\n`,
  );
  process.exitCode = 2;
} else {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      '--test-concurrency=1',
      ...selected.map((name) => path.join(directory, name)),
    ],
    { stdio: 'inherit' },
  );
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal === null ? 1 : 128);
  });
}
