import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';

import {
  assertPrivateRoot,
  gitDirectoryOf,
  inPrivateDirectory,
  removePrivateDirectory,
  runDirectories,
} from './restore-private-root.js';

// The private backup root of `npm run test:restore` and the directories a
// run keeps in it, in a temporary directory with synthetic files only.

const checkout = import.meta.dirname;
const names = ['synthetic.dump', 'synthetic.tar'];
const gitDirectoryPattern = /\.git/u;

// A fresh mode-700 root outside the repository, removed after the test.
const privateRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'restore-private-root-'));
  onTestFinished(() => rm(root, { force: true, recursive: true }));
  await chmod(root, 0o700);
  return root;
};

describe('the private backup root', () => {
  it('lies outside every git repository', async () => {
    const root = await privateRoot();

    await expect(gitDirectoryOf(checkout)).resolves.toMatch(
      gitDirectoryPattern,
    );
    await expect(gitDirectoryOf(root)).resolves.toBeNull();
    await expect(assertPrivateRoot(root)).resolves.toBeUndefined();
  });

  it('refuses a directory inside a checkout and one that others can read', async () => {
    const root = await privateRoot();

    await expect(assertPrivateRoot(checkout)).rejects.toThrow(
      'DIRECTUS_RESTORE_BACKUP_DIR must lie outside every git repository (a backup never enters one); refused',
    );

    await chmod(root, 0o750);

    await expect(assertPrivateRoot(root)).rejects.toThrow(
      'DIRECTUS_RESTORE_BACKUP_DIR must admit only its owner (mode 700); refused',
    );
  });

  it('lists only the directories of a run', async () => {
    const root = await privateRoot();
    await mkdir(path.join(root, 'restore-b'));
    await mkdir(path.join(root, 'restore-a'));
    await mkdir(path.join(root, 'other'));

    await expect(runDirectories(root)).resolves.toEqual([
      'restore-a',
      'restore-b',
    ]);
  });
});

describe('a directory of a run', () => {
  it('is removed with its known files when filling it fails', async () => {
    const root = await privateRoot();

    await expect(
      inPrivateDirectory(root, names, async (directory) => {
        await writeFile(path.join(directory, 'synthetic.dump'), 'partial', {
          mode: 0o600,
        });
        throw new Error('synthetic pg_dump failure');
      }),
    ).rejects.toThrow('synthetic pg_dump failure');
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it('reports both failures when a file of another name keeps it', async () => {
    const root = await privateRoot();

    await expect(
      inPrivateDirectory(root, names, async (directory) => {
        await writeFile(path.join(directory, 'unexpected.bin'), 'synthetic');
        throw new Error('synthetic tar failure');
      }),
    ).rejects.toThrow('was left after a failure; remove it by hand');
    await expect(runDirectories(root)).resolves.toHaveLength(1);
  });

  it('is private, answered when filled, and removed only under the root', async () => {
    const root = await privateRoot();
    const directory = await inPrivateDirectory(root, names, (created) =>
      Promise.resolve(created),
    );

    expect(path.dirname(directory)).toBe(root);
    await expect(runDirectories(root)).resolves.toEqual([
      path.basename(directory),
    ]);
    await expect(
      removePrivateDirectory(path.dirname(root), directory, names),
    ).rejects.toThrow('is not a directory of a restore run');
    await expect(
      removePrivateDirectory(root, path.join(root, 'other'), names),
    ).rejects.toThrow('is not a directory of a restore run');

    await removePrivateDirectory(root, directory, names);

    await expect(readdir(root)).resolves.toEqual([]);
  });
});
