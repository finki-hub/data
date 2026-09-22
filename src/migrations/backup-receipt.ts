import path from 'node:path';
import { z } from 'zod';

import { PrivateFileError, privateFileSize } from './private-files.js';

export const backupReceiptVersion = 'backup-receipt-1';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/u);

// The contract of the private backup receipt `--apply` requires: written by
// the backup rehearsal, it names every artifact with its size and checksum
// and the source fingerprint the backup was taken against.
export const backupReceiptSchema = z.object({
  artifacts: z
    .array(
      z.object({
        bytes: z.number().int().nonnegative(),
        kind: z.string().min(1),
        path: z.string().min(1),
        sha256: hex64,
      }),
    )
    .min(1),
  createdAt: z.string().min(1),
  sourceFingerprint: hex64,
  version: z.literal(backupReceiptVersion),
});

export type BackupReceipt = z.infer<typeof backupReceiptSchema>;

export class BackupReceiptError extends Error {
  public override readonly name = 'BackupReceiptError';
}

const parseReceipt = (candidate: unknown): BackupReceipt => {
  const parsed = backupReceiptSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new BackupReceiptError(
      `The backup receipt is not valid: ${parsed.error.issues
        .map(
          (issue) =>
            `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
        )
        .join('; ')}`,
    );
  }
  return parsed.data;
};

// Every artifact the receipt names must exist with the recorded size, so a
// receipt naming a deleted or never-created backup cannot unlock a write.
// Relative paths resolve against the receipt's own directory. Re-hashing
// the checksums belongs to the restore rehearsal, not to the apply gate.
const checkArtifact = async (
  artifact: BackupReceipt['artifacts'][number],
  baseDirectory: string,
): Promise<void> => {
  const file = path.resolve(baseDirectory, artifact.path);
  let size: number;
  try {
    size = await privateFileSize(file);
  } catch (error) {
    throw new BackupReceiptError(
      `The backup artifact ${artifact.path} named by the receipt is missing (${error instanceof PrivateFileError ? error.message : String(error)}); take a fresh backup before applying.`,
      { cause: error },
    );
  }
  if (size !== artifact.bytes) {
    throw new BackupReceiptError(
      `The backup artifact ${artifact.path} is ${String(size)} bytes but the receipt records ${String(artifact.bytes)}; the backup changed after the receipt was written. Take a fresh backup before applying.`,
    );
  }
};

export const validateBackupReceipt = async (
  candidate: unknown,
  sourceFingerprint: string,
  baseDirectory: string,
): Promise<{ readonly artifacts: number; readonly createdAt: string }> => {
  const receipt = parseReceipt(candidate);
  if (receipt.sourceFingerprint !== sourceFingerprint) {
    throw new BackupReceiptError(
      `The backup receipt records source fingerprint ${receipt.sourceFingerprint} but the report carries ${sourceFingerprint}; take a fresh backup of the current source before applying.`,
    );
  }
  for (const artifact of receipt.artifacts) {
    await checkArtifact(artifact, baseDirectory);
  }
  return {
    artifacts: receipt.artifacts.length,
    createdAt: receipt.createdAt,
  };
};
