import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { dockerReads } from './docker-reads.mjs';
import { assertMarkerPresent } from './isolated-target.mjs';
import { psql } from './relational/automatic-processing-helpers.mjs';
import {
  composeBindingOf,
  configHashOf,
  containerOf,
  docker,
  imageIdOf,
  licenceFailureLines,
  mountedVolume,
  recreateService,
  restoreSelect,
  runningServiceContainers,
  serviceConfigOf,
} from './restore-docker.mjs';
import {
  inPrivateDirectory,
  removePrivateDirectory,
} from './restore-private-root.js';
import {
  checkRestoreConfig,
  overrideYaml,
  uploadsTarget,
} from './restore-target.js';
import { identitySql, licenceOf } from './restore-verify.mjs';

// The restored project is served by the source project's own Directus
// container, recreated by its Compose project with one private override
// that points it at the restore database, uploads volume and bucket, and
// recreated back afterwards. That keeps the persisted licence identity in
// one container: the restored settings row carries the source's project id
// and encrypted licence key, and the service keeps the same licence key,
// SECRET and PUBLIC_URL (checkRestoreConfig), so Directus 12.3.1 finds a
// persisted key equal to its configured one and only refreshes it, as on
// every restart of the source; it never activates or updates a key. The
// identity row is compared as digests before and after each start: an
// activation or update would rewrite the encrypted key (a new salt) or the
// project id. Nothing here prints a setting's value.

const overrideName = 'compose.restore.yaml';
const imageSchema = z.looseObject({ image: z.string() });

const sameIdentity = async (restore, identity) =>
  isDeepStrictEqual(await restoreSelect(restore, identitySql), identity);

// Everything the switch relies on, checked before any change: the
// container does not still run with the override of an interrupted run,
// the environment reproduces the running configuration exactly (the same
// Compose hash), the image tag still names the running build, one
// container of the service runs, the licence is active, and the database
// the Directus container uses shares one network with it.
export const sourceOf = async ({ containers, target }) => {
  const binding = await composeBindingOf(containers.directus);
  assert.ok(
    binding.configFiles.every((file) => path.basename(file) !== overrideName),
    `${binding.container} still runs with the ${overrideName} of an interrupted rehearsal; recover it first (README, "Backup and restore"); refused before any change`,
  );
  assert.ok(
    (await configHashOf(binding)) === binding.configHash,
    `This environment does not reproduce the running configuration of ${binding.container} (load the Compose environment it was created with); refused before any change`,
  );
  const { image } = imageSchema.parse(await serviceConfigOf(binding));
  assert.ok(
    (await imageIdOf(image)) === binding.image,
    `${image} now names another build than ${binding.container} runs, so a recreate would change Directus; refused before any change`,
  );
  const running = await runningServiceContainers(binding);
  assert.equal(running.length, 1, `one ${binding.service} container runs`);
  const licence = await licenceOf(target);
  assert.equal(licence.status, 'active', 'the source licence is active');
  const database = await containerOf(containers.database);
  const directus = await containerOf(containers.directus);
  const reachable = new Set(
    Object.keys(await dockerReads.networks(containers.directus)),
  );
  const networks = Object.keys(
    await dockerReads.networks(containers.database),
  ).filter((network) => reachable.has(network));
  assert.equal(
    networks.length,
    1,
    'one network joins Directus and its database',
  );
  const owner = await docker([
    'exec',
    containers.directus,
    'stat',
    '-c',
    '%u:%g',
    uploadsTarget,
  ]);
  return {
    binding,
    databaseImage: database.configImage,
    dbHost: await dockerReads.setting(containers.directus, 'DB_HOST'),
    identity: await psql(identitySql, containers.database),
    licence,
    network: networks[0],
    owner: owner.trim(),
    uploadsVolume: mountedVolume(directus, uploadsTarget),
  };
};

// The private override file, mode 600 in its own mode-700 directory under
// the backup root (removed again when it cannot be written).
const writeOverride = (restore, values) =>
  inPrivateDirectory(restore.backupRoot, [overrideName], async (directory) => {
    const file = path.join(directory, overrideName);
    await writeFile(file, overrideYaml(values), { flag: 'wx', mode: 0o600 });
    return { directory, file };
  });

export const removeOverride = async (restore, override) => {
  assert.equal(path.join(override.directory, overrideName), override.file);
  await removePrivateDirectory(restore.backupRoot, override.directory, [
    overrideName,
  ]);
};

// Recreates the one Directus container of the source project on the
// restore database. Refused unless the override changes only the database
// connection, the bucket and the uploads volume, and the restored settings
// carry the source's project and licence identity.
export const switchToRestore = async (context) => {
  const { restore, source, state, t, target } = context;
  state.override = await writeOverride(restore, {
    alias: restore.alias,
    bucket: restore.bucket,
    password: state.databasePassword,
    service: source.binding.service,
    uploadsVolume: restore.uploadsVolume,
  });
  const changes = checkRestoreConfig(
    await serviceConfigOf(source.binding),
    await serviceConfigOf(source.binding, [state.override.file]),
  );
  assert.ok(
    await sameIdentity(restore, source.identity),
    'The restored settings do not carry the source project and licence identity, so the licensed container is not started on them; refused',
  );
  state.switched = true;
  state.switchedAt = Date.now();
  const binding = await recreateService(
    source.binding,
    [state.override.file],
    target,
  );
  assert.ok(binding.configHash !== source.binding.configHash);
  assert.equal(
    await dockerReads.setting(binding.container, 'DB_HOST'),
    restore.alias,
  );
  assert.equal(
    await dockerReads.setting(binding.container, 'STORAGE_PUBLISH_BUCKET'),
    restore.bucket,
  );
  assert.equal(
    mountedVolume(await containerOf(binding.container), uploadsTarget),
    restore.uploadsVolume,
  );
  assert.ok(
    isDeepStrictEqual(await licenceOf(target), source.licence),
    'the restored project runs the source licence state',
  );
  assert.ok(
    await sameIdentity(restore, source.identity),
    'the start rewrote the persisted project or licence key',
  );
  assert.equal(
    await licenceFailureLines(binding.container),
    0,
    'the restored project refreshed its licence without a failure',
  );
  await assertMarkerPresent(target);
  t.diagnostic(
    `served from the restore database after ${String(Date.now() - state.switchedAt)} ms; the service changed only ${[...changes.environment, ...changes.volumes].join(', ')}`,
  );
};

// Recreates the source project's Directus from its own files. Only when
// the Compose hash, the database host and the uploads volume are the ones
// it started with, its licence state and identity row are unchanged, it
// refreshed without a licence failure and the marker answers is the
// source back (`state.backOnSource`); otherwise the fixture is not
// touched again and its teardown is skipped.
export const switchBack = async (context) => {
  const { containers, source, state, t, target } = context;
  const skipped =
    'the fixture teardown is skipped: recover it first (README, "Backup and restore")';
  const binding = await recreateService(source.binding, [], target);
  const container = await containerOf(binding.container);
  assert.ok(
    binding.configHash === source.binding.configHash &&
      (await dockerReads.setting(binding.container, 'DB_HOST')) ===
        source.dbHost &&
      mountedVolume(container, uploadsTarget) === source.uploadsVolume,
    `${binding.container} is not back on its own database and uploads; ${skipped}`,
  );
  assert.ok(
    isDeepStrictEqual(await licenceOf(target), source.licence),
    `the source licence state changed; ${skipped}`,
  );
  assert.ok(
    isDeepStrictEqual(
      await psql(identitySql, containers.database),
      source.identity,
    ),
    `the source settings no longer carry the same project and licence key; ${skipped}`,
  );
  assert.equal(
    await licenceFailureLines(binding.container),
    0,
    `the source refreshed its licence with a failure; ${skipped}`,
  );
  await assertMarkerPresent(target);
  state.backOnSource = true;
  t.diagnostic(
    `the source Directus is back on its own database; the restored project was served for ${String(Date.now() - state.switchedAt)} ms`,
  );
};
