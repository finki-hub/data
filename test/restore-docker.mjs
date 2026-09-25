import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

import { waitForDirectus } from './relational/automatic-processing-helpers.mjs';
import { disposableLabel } from './restore-target.js';

// The Docker side of the restore rehearsal (restore.integration.mjs).
// Everything it creates carries the disposable label valued with the
// restore target's name and an exact name derived from it; it is removed by
// that exact name after the label is read back, never by pattern or prune.
// The Directus container of the source project is never removed by name:
// it is recreated by its own Compose project (the files, project and
// service its labels record) with one more private override file, and
// recreated back without it. Before either recreate every running
// container of that service is stopped, so at most one Directus process
// ever serves the source project's settings and persisted licence
// identity. Container environments are never read whole: only labels,
// mounts and named non-secret settings.

const maxBuffer = 64 * 1_024 * 1_024;
const missingPattern = /no such (?:container|object|volume)/iu;
const ownerPattern = /^\d+:\d+$/u;

// A Docker command's standard output. A failure names the command and the
// tail of its standard error, never its output (a resolved Compose
// configuration holds the service's secrets).
export const docker = (args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      'docker',
      args,
      { maxBuffer, ...options },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        reject(
          new Error(
            `docker ${args.slice(0, 2).join(' ')} failed (exit ${String(error.code)}): ${String(stderr).trim().slice(-600)}`,
          ),
        );
      },
    );
  });

const licenceFailure =
  /activation_limit|binding_mismatch|licenseservererror|license_canceled|license_expired|license_suspended|unable to validate|licensing\.directus|enotfound|fetch failed|jwks/iu;

// How many lines of a container's log report a licence failure (a
// refused or failed refresh, a downgrade); the log itself is not kept.
export const licenceFailureLines = (name) =>
  new Promise((resolve, reject) => {
    execFile(
      'docker',
      ['logs', name],
      { maxBuffer },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`docker logs failed (exit ${String(error.code)})`));
          return;
        }
        const lines = `${stdout}\n${stderr}`.split('\n');
        resolve(lines.filter((line) => licenceFailure.test(line)).length);
      },
    );
  });

const streamed = (args, { input, output }) =>
  new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: [input ? 'pipe' : 'ignore', output ? 'pipe' : 'ignore', 'pipe'],
    });
    const errors = [];
    child.stderr.on('data', (chunk) => {
      errors.push(chunk);
    });
    if (input) createReadStream(input).on('error', reject).pipe(child.stdin);
    if (output) child.stdout.pipe(output);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const stderr = Buffer.concat(errors).toString('utf8').trim();
      reject(
        new Error(
          `docker ${args.slice(0, 2).join(' ')} failed (exit ${String(code)}): ${stderr.slice(-600)}`,
        ),
      );
    });
  });

// Streams a Docker command's output into a new private file (mode 600)
// and waits for both the command and the file.
export const dockerInto = async (args, file) => {
  const output = createWriteStream(file, { flags: 'wx', mode: 0o600 });
  const closed = new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
  });
  await Promise.all([streamed(args, { output }), closed]);
};

// Streams a file into a Docker command's input.
export const dockerFrom = (args, file) => streamed(args, { input: file });

const containerSchema = z.object({
  configImage: z.string(),
  id: z.string(),
  image: z.string(),
  labels: z.record(z.string(), z.string()).nullable(),
  mounts: z.array(
    z.looseObject({
      Destination: z.string(),
      Name: z.string().optional(),
      Type: z.string(),
    }),
  ),
  running: z.boolean(),
});

const containerFormat =
  '{"configImage":{{json .Config.Image}},"id":{{json .Id}},"image":{{json .Image}},"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},"running":{{json .State.Running}}}';

// A container's id, image, labels, mounts and state (never its
// environment), or null when no container has that name.
export const containerOf = async (name) => {
  try {
    const text = await docker([
      'container',
      'inspect',
      '--format',
      containerFormat,
      name,
    ]);
    return containerSchema.parse(JSON.parse(text));
  } catch (error) {
    if (missingPattern.test(String(error?.message))) return null;
    throw error;
  }
};

const volumeLabels = async (name) => {
  try {
    const text = await docker([
      'volume',
      'inspect',
      '--format',
      '{{json .Labels}}',
      name,
    ]);
    return { labels: JSON.parse(text) ?? {} };
  } catch (error) {
    if (missingPattern.test(String(error?.message))) return null;
    throw error;
  }
};

// The volume mounted at a path of a container, or null.
export const mountedVolume = (container, destination) =>
  container.mounts.find((mount) => mount.Destination === destination)?.Name ??
  null;

const composeLabels = {
  configFiles: 'com.docker.compose.project.config_files',
  configHash: 'com.docker.compose.config-hash',
  project: 'com.docker.compose.project',
  service: 'com.docker.compose.service',
};

// The Compose project a container belongs to, from its labels: the
// project, the service, the files it was created from and the hash of
// its resolved configuration.
export const composeBindingOf = async (name) => {
  const container = await containerOf(name);
  assert.ok(container !== null, `${name} does not exist`);
  const label = (key) => {
    const value = container.labels?.[composeLabels[key]];
    assert.ok(
      value,
      `${name} was not created by Docker Compose (no ${composeLabels[key]}); refused`,
    );
    return value;
  };
  return {
    configFiles: label('configFiles').split(','),
    configHash: label('configHash'),
    container: name,
    id: container.id,
    image: container.image,
    project: label('project'),
    service: label('service'),
  };
};

// The documented recreate command of the project: no .env, the project's
// own files, then any extra override.
const composeArgs = (binding, extraFiles) => [
  'compose',
  '--env-file',
  '/dev/null',
  '-p',
  binding.project,
  ...[...binding.configFiles, ...extraFiles].flatMap((file) => ['-f', file]),
];

// The hash of the service's resolved configuration.
export const configHashOf = async (binding, extraFiles = []) => {
  const text = await docker([
    ...composeArgs(binding, extraFiles),
    'config',
    '--hash',
    binding.service,
  ]);
  const [service, hash] = text.trim().split(' ');
  assert.equal(service, binding.service);
  return hash;
};

// The service's resolved definition. It holds the service's secrets, so it
// is only compared in this process: never printed or written.
export const serviceConfigOf = async (binding, extraFiles = []) => {
  const text = await docker([
    ...composeArgs(binding, extraFiles),
    'config',
    '--format',
    'json',
  ]);
  const { services } = z
    .object({ services: z.record(z.string(), z.unknown()) })
    .parse(JSON.parse(text));
  return services[binding.service];
};

// The image id a tag names now.
export const imageIdOf = async (image) => {
  const text = await docker(['image', 'inspect', '--format', '{{.Id}}', image]);
  return text.trim();
};

// The running containers of the service, by id.
export const runningServiceContainers = async (binding) => {
  const text = await docker([
    'ps',
    '-q',
    '--no-trunc',
    '--filter',
    `label=${composeLabels.project}=${binding.project}`,
    '--filter',
    `label=${composeLabels.service}=${binding.service}`,
  ]);
  return text.split('\n').filter((id) => id !== '');
};

// Stops every running container of the service, then lets Compose
// recreate it from the project's files plus `extraFiles` without building
// or touching another service, and waits until the target answers. Answers
// the new binding; exactly one container of the service runs.
export const recreateService = async (binding, extraFiles, target) => {
  const before = await runningServiceContainers(binding);
  for (const id of before) await docker(['stop', id]);
  assert.deepEqual(
    await runningServiceContainers(binding),
    [],
    'no container of the service runs before the recreate',
  );
  await docker([
    ...composeArgs(binding, extraFiles),
    'up',
    '--detach',
    '--no-build',
    '--no-deps',
    binding.service,
  ]);
  await waitForDirectus(target);
  const running = await runningServiceContainers(binding);
  assert.equal(running.length, 1, 'exactly one container of the service runs');
  return composeBindingOf(binding.container);
};

// The restore target's resources, each with its exact name.
export const restoreResources = (restore) => [
  { kind: 'container', name: restore.database },
  { kind: 'volume', name: restore.databaseVolume },
  { kind: 'volume', name: restore.uploadsVolume },
];

// Whether a resource exists and whether it carries the disposable label
// of this restore target.
export const resourceState = async ({ kind, name }, restore) => {
  const found =
    kind === 'container' ? await containerOf(name) : await volumeLabels(name);
  if (found === null) return { exists: false, owned: false };
  return {
    exists: true,
    owned: found.labels?.[disposableLabel] === restore.name,
  };
};

// Refuses a restore target any of whose names belongs to something the
// harness did not create for it.
export const assertDisposable = async (restore) => {
  for (const resource of restoreResources(restore)) {
    const state = await resourceState(resource, restore);
    assert.ok(
      !state.exists || state.owned,
      `${resource.name} exists and is not a disposable resource of ${restore.name}; refused before any write`,
    );
  }
};

// Creates the restore volumes and the PostgreSQL container that are not
// there yet (same image as the source database, on the source project's
// network under the target's alias, no published port) and waits until
// it accepts connections over TCP, which only the final server does.
export const provideDatabase = async (
  restore,
  { image, network, password },
) => {
  const label = `${disposableLabel}=${restore.name}`;
  for (const resource of restoreResources(restore)) {
    const state = await resourceState(resource, restore);
    if (state.exists || resource.kind !== 'volume') continue;
    await docker(['volume', 'create', '--label', label, resource.name]);
  }
  const [container] = restoreResources(restore);
  const database = await resourceState(container, restore);
  if (!database.exists) {
    await docker(
      [
        'run',
        '--detach',
        '--name',
        restore.database,
        '--label',
        label,
        '--network',
        network,
        '--network-alias',
        restore.alias,
        '--env',
        'POSTGRES_DB=directus',
        '--env',
        'POSTGRES_USER=directus',
        '--env',
        'POSTGRES_PASSWORD',
        '--volume',
        `${restore.databaseVolume}:/var/lib/postgresql`,
        image,
      ],
      { env: { ...process.env, POSTGRES_PASSWORD: password } },
    );
  }
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await docker([
        'exec',
        restore.database,
        'pg_isready',
        '--host',
        '127.0.0.1',
        '--username',
        'directus',
        '--dbname',
        'directus',
      ]);
      return;
    } catch {
      await sleep(500);
    }
  }
  assert.fail(`${restore.database} did not accept connections`);
};

// One SELECT in a restore database, read-only, answered as rows of fields.
export const restoreSelect = async (restore, sql) => {
  const text = await docker([
    'exec',
    '--env',
    'PGOPTIONS=-c default_transaction_read_only=on',
    restore.database,
    'psql',
    '--no-psqlrc',
    '--set',
    'ON_ERROR_STOP=1',
    '--username',
    'directus',
    '--dbname',
    'directus',
    '--tuples-only',
    '--no-align',
    '--field-separator',
    '|',
    '--command',
    sql,
  ]);
  return text
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split('|'));
};

// The writes outside a restore, both into a disposable restore target,
// each of which makes it a non-empty target: a synthetic view (a schema
// object that is not a table) in its database, and one synthetic file in
// its uploads volume.
export const writeProbeView = (restore) =>
  docker([
    'exec',
    restore.database,
    'psql',
    '--no-psqlrc',
    '--set',
    'ON_ERROR_STOP=1',
    '--username',
    'directus',
    '--dbname',
    'directus',
    '--command',
    'CREATE VIEW synthetic_restore_probe AS SELECT 1 AS id',
  ]);

export const probeUpload = 'synthetic-restore-probe';

export const writeProbeUpload = (restore, image) =>
  docker([
    'run',
    '--rm',
    '--label',
    `${disposableLabel}=${restore.name}`,
    '--volume',
    `${restore.uploadsVolume}:/restore`,
    image,
    'sh',
    '-c',
    `printf synthetic > /restore/${probeUpload}`,
  ]);

// The tables outside the system schemas of the restore database.
export const restoreTableCount = async (restore) => {
  const [[count]] = await restoreSelect(
    restore,
    "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')",
  );
  return Number(count);
};

// Everything a fresh database does not hold, which an empty restore target
// must not hold either: a schema besides public, a relation of any kind
// (table, view, sequence, index, materialized or foreign table), a
// function, a type, an extension besides plpgsql, a large object.
const ownSchemas = String.raw`SELECT oid, nspname FROM pg_catalog.pg_namespace WHERE nspname NOT IN ('pg_catalog', 'information_schema') AND nspname NOT LIKE 'pg\_toast%' AND nspname NOT LIKE 'pg\_temp\_%'`;
const objectCountSql = [
  `WITH own AS (${ownSchemas}) SELECT`,
  "(SELECT count(*) FROM own WHERE nspname <> 'public')",
  '+ (SELECT count(*) FROM pg_catalog.pg_class WHERE relnamespace IN (SELECT oid FROM own))',
  '+ (SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace IN (SELECT oid FROM own))',
  '+ (SELECT count(*) FROM pg_catalog.pg_type WHERE typnamespace IN (SELECT oid FROM own))',
  "+ (SELECT count(*) FROM pg_catalog.pg_extension WHERE extname <> 'plpgsql')",
  '+ (SELECT count(*) FROM pg_catalog.pg_largeobject_metadata)',
].join(' ');

// How many such objects the restore database holds (0 when fresh).
export const restoreObjectCount = async (restore) => {
  const [[count]] = await restoreSelect(restore, objectCountSql);
  return Number(count);
};

// The entries of the restore uploads volume, listed by a one-off
// container of the database image that mounts it read-only.
export const uploadsEntries = async (restore, image) => {
  const text = await docker([
    'run',
    '--rm',
    '--label',
    `${disposableLabel}=${restore.name}`,
    '--volume',
    `${restore.uploadsVolume}:/restore:ro`,
    image,
    'ls',
    '-A',
    '/restore',
  ]);
  return text.split('\n').filter((entry) => entry !== '');
};

// Unpacks an uploads archive into the restore uploads volume and gives
// its root the owner the source's uploads directory had.
export const loadUploads = async (restore, { archive, image, owner }) => {
  assert.match(owner, ownerPattern);
  await dockerFrom(
    [
      'run',
      '--rm',
      '--interactive',
      '--label',
      `${disposableLabel}=${restore.name}`,
      '--volume',
      `${restore.uploadsVolume}:/restore`,
      image,
      'sh',
      '-c',
      `tar -x -f - -C /restore && chown ${owner} /restore`,
    ],
    archive,
  );
};

// Removes the restore target's resources that exist and carry its label,
// the container first; anything else of the same name is left alone and
// reported.
export const removeRestoreResources = async (restore) => {
  const kept = [];
  for (const resource of restoreResources(restore)) {
    const state = await resourceState(resource, restore);
    if (!state.exists) continue;
    if (!state.owned) {
      kept.push(resource.name);
      continue;
    }
    await docker(
      resource.kind === 'container'
        ? ['container', 'rm', '--force', '--volumes', resource.name]
        : ['volume', 'rm', resource.name],
    );
  }
  return kept;
};
