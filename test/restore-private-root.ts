import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readdir, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

// The operator's private backup root of the restore rehearsal
// (restore.integration.mjs) and the directories a run keeps in it. Every
// backup set, damaged copy and Compose override is one mode-700
// `restore-…` directory directly under the root, holding mode-600 files of
// known names. A directory is removed file by known name and then as an
// empty directory, never recursively, and one whose filling fails is
// removed before the failure is reported. The root must admit only its
// owner and lie outside every Git repository: a dump holds password
// hashes, static and session tokens in plain text and the encrypted
// licence. A run starts only when the root holds no directory of an
// earlier run.

export const runPrefix = 'restore-';

const privateMode = 0o700;
const collator = new Intl.Collator('en');
const notRepositoryPattern = /not a git repository/iu;

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

// The Git directory that Git's own discovery finds at or above
// `directory`, or null. GIT_* settings of the environment (a hook's
// GIT_DIR, a ceiling) are left out, so they neither hide nor invent a
// repository; any other failure refuses.
export const gitDirectoryOf = (directory: string): Promise<null | string> => {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', directory, 'rev-parse', '--absolute-git-dir'],
      { env: environment },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout.trim());
          return;
        }
        if (notRepositoryPattern.test(stderr)) {
          resolve(null);
          return;
        }
        reject(
          new Error(
            `git could not tell whether ${directory} lies in a repository (exit ${String(error.code)}); refused`,
          ),
        );
      },
    );
  });
};

// The root exists, lies in no Git repository and admits only its owner.
export const assertPrivateRoot = async (root: string): Promise<void> => {
  const { mode } = await stat(root);
  if ((await gitDirectoryOf(root)) !== null) {
    throw new Error(
      'DIRECTUS_RESTORE_BACKUP_DIR must lie outside every git repository (a backup never enters one); refused',
    );
  }
  if (mode % 0o100 !== 0) {
    throw new Error(
      'DIRECTUS_RESTORE_BACKUP_DIR must admit only its owner (mode 700); refused',
    );
  }
};

// The `restore-…` entries directly under the root, sorted.
export const runDirectories = async (root: string): Promise<string[]> => {
  const entries = await readdir(root);
  return entries
    .filter((name) => name.startsWith(runPrefix))
    .toSorted((left, right) => collator.compare(left, right));
};

// Removes one directory of a run: only a `restore-…` directory directly
// under the root, each known file by name, then the empty directory.
export const removePrivateDirectory = async (
  root: string,
  directory: string,
  names: readonly string[],
): Promise<void> => {
  if (
    path.dirname(directory) !== root ||
    !path.basename(directory).startsWith(runPrefix)
  ) {
    throw new Error(
      `${directory} is not a directory of a restore run under the backup root; refused`,
    );
  }
  for (const name of names) {
    try {
      await unlink(path.join(directory, name));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  await rmdir(directory);
};

// Creates a new private directory under the root and fills it. When the
// filling fails, the directory (with every file of `names` it got) is
// removed first; if that removal fails too, both failures are reported.
export const inPrivateDirectory = async <Result>(
  root: string,
  names: readonly string[],
  fill: (directory: string) => Promise<Result>,
): Promise<Result> => {
  const directory = await mkdtemp(path.join(root, runPrefix));
  try {
    await chmod(directory, privateMode);
    return await fill(directory);
  } catch (error) {
    try {
      await removePrivateDirectory(root, directory, names);
    } catch (error_) {
      throw new AggregateError(
        [error, error_],
        `${directory} was left after a failure; remove it by hand`,
        { cause: error_ },
      );
    }
    throw error;
  }
};
