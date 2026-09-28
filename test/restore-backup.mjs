import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  readFile,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  backupFiles,
  backupProblems,
  checksumsText,
  manifestSchema,
  parseChecksums,
} from './restore-backup-set.js';
import {
  assertDisposable,
  dockerFrom,
  dockerInto,
  loadUploads,
  provideDatabase,
  restoreObjectCount,
  uploadsEntries,
} from './restore-docker.mjs';
import {
  assertPrivateRoot,
  inPrivateDirectory,
  removePrivateDirectory,
} from './restore-private-root.js';

// The private backup of the restore rehearsal and its restore. A backup
// set is one mode-700 directory under the operator's private backup root
// holding mode-600 files: a custom-format pg_dump of the source database,
// a tar archive of the source's uploads volume, SHA256SUMS and a manifest.
// Both are read through the source containers (`pg_dump` in the database
// container, `tar` of /directus/uploads in the Directus container), which
// only reads them; a set whose taking fails is removed before the failure
// is reported (restore-private-root.ts). A restore verifies the whole set
// first, so a truncated or altered dump is refused before any restore
// resource is created or written; then it refuses a target that is not
// disposable or not empty, and only then loads the dump and the archive.

const fileMode = 0o600;
const setNames = Object.values(backupFiles);

const measure = async (file) => {
  try {
    const { size } = await stat(file);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return { bytes: size, sha256: hash.digest('hex') };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};

const writePrivate = (file, text) =>
  writeFile(file, text, { flag: 'wx', mode: fileMode });

// Takes the backup of the source project into a new private directory and
// answers it with its manifest.
export const createBackup = async ({ binding, containers, restore }) => {
  await assertPrivateRoot(restore.backupRoot);
  return inPrivateDirectory(restore.backupRoot, setNames, async (directory) => {
    const database = path.join(directory, backupFiles.database);
    const uploads = path.join(directory, backupFiles.uploads);
    await dockerInto(
      [
        'exec',
        containers.database,
        'pg_dump',
        '--format=custom',
        '--username',
        'directus',
        '--dbname',
        'directus',
      ],
      database,
    );
    await dockerInto(
      [
        'exec',
        containers.directus,
        'tar',
        '-c',
        '-f',
        '-',
        '-C',
        '/directus/uploads',
        '.',
      ],
      uploads,
    );
    const artifacts = [];
    for (const [kind, file] of [
      ['database', database],
      ['uploads', uploads],
    ]) {
      const measured = await measure(file);
      assert.ok(measured !== null && measured.bytes > 0, `${kind} artifact`);
      artifacts.push({ ...measured, file: path.basename(file), kind });
    }
    const manifest = manifestSchema.parse({
      artifacts,
      createdAt: new Date().toISOString(),
      source: {
        database: containers.database,
        directus: containers.directus,
        project: binding.project,
      },
      version: 'restore-backup-1',
    });
    await writePrivate(
      path.join(directory, backupFiles.checksums),
      checksumsText(manifest.artifacts),
    );
    await writePrivate(
      path.join(directory, backupFiles.manifest),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return { directory, manifest };
  });
};

// Measures every artifact again against the manifest and SHA256SUMS;
// refuses the set, naming each problem, when anything differs (the
// manifest must also keep each artifact under the name the restore reads).
// Reads only.
const verifyBackup = async (directory) => {
  const manifest = manifestSchema.parse(
    JSON.parse(
      await readFile(path.join(directory, backupFiles.manifest), 'utf8'),
    ),
  );
  const checksums = parseChecksums(
    await readFile(path.join(directory, backupFiles.checksums), 'utf8'),
  );
  const measured = new Map();
  for (const { file } of manifest.artifacts) {
    measured.set(file, await measure(path.join(directory, file)));
  }
  const problems = backupProblems(manifest, checksums, measured);
  if (problems.length > 0) {
    throw new Error(
      `The backup set is refused before any write: ${problems.join('; ')}`,
    );
  }
  return manifest;
};

// A copy of a backup set whose dump is truncated to half its size, or has
// one byte flipped in the middle, with the original records: what a
// broken transfer or a damaged disk would leave. A copy that fails
// half-way is removed before the failure is reported.
export const damagedCopy = (restore, backup, damage) =>
  inPrivateDirectory(restore.backupRoot, setNames, async (directory) => {
    for (const name of setNames) {
      await copyFile(
        path.join(backup.directory, name),
        path.join(directory, name),
      );
      await chmod(path.join(directory, name), fileMode);
    }
    const dump = path.join(directory, backupFiles.database);
    const { size } = await stat(dump);
    if (damage === 'truncated') {
      await truncate(dump, Math.floor(size / 2));
    } else {
      const bytes = await readFile(dump);
      const middle = Math.floor(size / 2);
      bytes.writeUInt8(((bytes[middle] ?? 0) + 1) % 256, middle);
      await writeFile(dump, bytes);
    }
    return { directory };
  });

// Removes one backup set this run wrote: only a `restore-` directory
// directly under the private root, file by known name, then the directory.
export const removeBackup = (restore, backup) =>
  removePrivateDirectory(restore.backupRoot, backup.directory, setNames);

// Restores a backup set into the restore target: the set is verified
// before anything is created; the target must be disposable (its names
// free or carrying its label) and empty (no schema object, no upload);
// then the dump is restored in one transaction and the archive unpacked.
export const restoreBackup = async (restore, backup, options) => {
  await verifyBackup(backup.directory);
  await assertDisposable(restore);
  await provideDatabase(restore, options);
  const objects = await restoreObjectCount(restore);
  assert.equal(
    objects,
    0,
    `${restore.database} already holds ${String(objects)} schema objects: not an empty restore target; refused before any write`,
  );
  const uploads = await uploadsEntries(restore, options.image);
  assert.equal(
    uploads.length,
    0,
    `${restore.uploadsVolume} is not empty; refused before any write`,
  );
  await dockerFrom(
    [
      'exec',
      '--interactive',
      restore.database,
      'pg_restore',
      '--exit-on-error',
      '--single-transaction',
      '--username',
      'directus',
      '--dbname',
      'directus',
    ],
    path.join(backup.directory, backupFiles.database),
  );
  await loadUploads(restore, {
    archive: path.join(backup.directory, backupFiles.uploads),
    image: options.image,
    owner: options.owner,
  });
};
