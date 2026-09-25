// `npm run test:relational [-- --scenario <name>]`: runs the fixture suites
// test/relational/*.integration.mjs one after another, or only the one
// named. An opt-in scenario (test/relational/<name>.opt-in.mjs, such as
// the full-size stress run) never runs by default, only when it is named,
// so the default suite stays bounded. The suites read the explicit target
// from DIRECTUS_SEARCH_TEST_* variables.
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { containersFrom, isolatedTargets } from '../isolated-target.mjs';

const directory = import.meta.dirname;
const suffix = '.integration.mjs';
const optInSuffix = '.opt-in.mjs';
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

// The optional containers of the restart and database-statistics subtests
// (DIRECTUS_COORDINATION_RESTART_CONTAINER, which they `docker restart`,
// and DIRECTUS_AUTOMATIC_DATABASE_CONTAINER, which they `docker exec`
// into) are bound to the target once, before any scenario runs: read-only
// Docker commands show that the Directus container publishes the target's
// port and that the database container is the PostgreSQL server that
// Directus connects to (so it needs the Directus container named too). A
// container of another project is refused before anything touches it.
// Answers whether the scenarios may run; a refusal names the rule only.
const containersBound = async () => {
  try {
    const named = containersFrom(process.env);
    const needed = Object.keys(named).filter((name) => named[name] !== null);
    if (needed.length > 0) {
      await isolatedTargets(process.env, { containers: needed });
    }
    return true;
  } catch (error) {
    process.stderr.write(
      `Refused before any scenario ran: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return false;
  }
};

const entries = await readdir(directory);
const suites = entries.filter((name) => name.endsWith(suffix)).toSorted();
const optIn = entries.filter((name) => name.endsWith(optInSuffix)).toSorted();
const scenario = scenarioOf(process.argv.slice(2));
const selected =
  scenario === null
    ? suites
    : [...suites, ...optIn].filter(
        (name) =>
          name === `${scenario}${suffix}` ||
          name === `${scenario}${optInSuffix}`,
      );
const known = [
  ...suites.map((name) => name.slice(0, -suffix.length)),
  ...optIn.map((name) => `${name.slice(0, -optInSuffix.length)} (opt-in)`),
];

if (selected.length === 0) {
  process.stderr.write(
    `Unknown scenario "${scenario}". Known: ${known.join(', ')}.\n`,
  );
  process.exitCode = 2;
} else if (await containersBound()) {
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
} else {
  process.exitCode = 2;
}
