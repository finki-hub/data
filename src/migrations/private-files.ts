import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

// The only file access of the migration CLI: the report and the backup
// receipt live at the private paths the operator names on the command line,
// never at a default location; the report is owner-only from its first
// byte, and the artifacts a receipt names are checked to be present.

export class PrivateFileError extends Error {
  public override readonly name = 'PrivateFileError';
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const readPrivateJson = async (
  file: string,
  what: string,
): Promise<unknown> => {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new PrivateFileError(
      `The ${what} at ${file} cannot be read: ${describe(error)}`,
      { cause: error },
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new PrivateFileError(`The ${what} at ${file} is not JSON.`, {
      cause: error,
    });
  }
};

export const privateFileSize = async (file: string): Promise<number> => {
  try {
    const { size } = await stat(file);
    return size;
  } catch (error) {
    throw new PrivateFileError(
      `The file at ${file} cannot be read: ${describe(error)}`,
      { cause: error },
    );
  }
};

// Creates the file exclusively with owner-only mode (re-applied in case of
// a permissive umask) and fills it.
const createOwnerOnly = async (file: string, text: string): Promise<void> => {
  await using handle = await open(file, 'wx', 0o600);
  await handle.chmod(0o600);
  await handle.writeFile(text, 'utf8');
};

// The report is written to an exclusively created, owner-only sibling and
// then renamed over the target path: no byte of it ever sits in a file with
// wider permissions, and a pre-existing file or link at the path is replaced
// rather than written through. Parent directories are created owner-only.
export const writePrivateJson = async (
  file: string,
  value: unknown,
): Promise<void> => {
  await mkdir(path.dirname(file), { mode: 0o700, recursive: true });
  const staging = `${file}.${randomUUID()}.tmp`;
  try {
    await createOwnerOnly(staging, `${JSON.stringify(value, null, 2)}\n`);
    await rename(staging, file);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
};
