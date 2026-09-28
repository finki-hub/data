import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

// The private backup set of the restore rehearsal: a custom-format
// PostgreSQL dump, an archive of the uploads volume, their SHA-256
// checksums in `sha256sum` format and a manifest naming the source, each
// artifact's kind and size. A set is restored only after every artifact is
// measured again under its fixed name and equals both records, so a
// truncated or altered dump is refused before anything is created or
// written. Problems name a file and a rule, never content.

const artifactKinds = ['database', 'uploads'] as const;

export const backupFiles = {
  checksums: 'SHA256SUMS',
  database: 'directus.dump',
  manifest: 'manifest.json',
  uploads: 'uploads.tar',
} as const;

const collator = new Intl.Collator('en');
const shaPattern = /^[0-9a-f]{64}$/u;
const filePattern = /^[a-z0-9][a-z0-9.-]*$/u;
const linePattern = /^(?<sha>[0-9a-f]{64}) {2}(?<file>[a-z0-9][a-z0-9.-]*)$/u;

export const manifestSchema = z.object({
  artifacts: z.array(
    z.object({
      bytes: z.number().int().positive(),
      file: z.string().regex(filePattern),
      kind: z.enum(artifactKinds),
      sha256: z.string().regex(shaPattern),
    }),
  ),
  createdAt: z.iso.datetime(),
  source: z.object({
    database: z.string(),
    directus: z.string(),
    project: z.string(),
  }),
  version: z.literal('restore-backup-1'),
});

export type BackupManifest = z.infer<typeof manifestSchema>;
type Artifact = BackupManifest['artifacts'][number];

// A measured artifact, or null when the file is missing.
export type Measured = null | {
  readonly bytes: number;
  readonly sha256: string;
};

// The checksum file, one `<sha256>  <file>` line per artifact.
export const checksumsText = (artifacts: readonly Artifact[]): string =>
  artifacts.map(({ file, sha256 }) => `${sha256}  ${file}\n`).join('');

// The checksum of every file the checksum file lists; a malformed or
// repeated line refuses the whole set.
export const parseChecksums = (text: string): ReadonlyMap<string, string> => {
  const checksums = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const groups = linePattern.exec(line)?.groups;
    const file = groups?.['file'];
    const sha = groups?.['sha'];
    if (file === undefined || sha === undefined) {
      throw new Error(
        `${backupFiles.checksums} holds a malformed line; refused`,
      );
    }
    if (checksums.has(file)) {
      throw new Error(`${backupFiles.checksums} lists ${file} twice; refused`);
    }
    checksums.set(file, sha);
  }
  return checksums;
};

// Every reason not to restore the set: the manifest must name exactly one
// dump and one uploads archive, each under the file name the restore
// reads (so what is verified is what is loaded), both records must agree,
// and each file must exist with exactly the recorded size and checksum.
export const backupProblems = (
  manifest: BackupManifest,
  checksums: ReadonlyMap<string, string>,
  measured: ReadonlyMap<string, Measured>,
): readonly string[] => {
  const problems: string[] = [];
  const kinds = manifest.artifacts
    .map(({ kind }) => kind)
    .toSorted((left, right) => collator.compare(left, right));
  if (!isDeepStrictEqual(kinds, [...artifactKinds])) {
    problems.push(
      'the manifest must name exactly one database dump and one uploads archive',
    );
  }
  for (const artifact of manifest.artifacts) {
    const restored = backupFiles[artifact.kind];
    if (artifact.file !== restored) {
      problems.push(
        `the manifest names ${artifact.file} as the ${artifact.kind} artifact, but the restore reads ${restored}`,
      );
    }
    const actual = measured.get(artifact.file) ?? null;
    if (checksums.get(artifact.file) !== artifact.sha256) {
      problems.push(
        `${artifact.file}: ${backupFiles.checksums} and the manifest disagree`,
      );
    }
    if (actual === null) {
      problems.push(`${artifact.file} is missing`);
      continue;
    }
    if (actual.bytes !== artifact.bytes) {
      problems.push(
        `${artifact.file} holds ${String(actual.bytes)} bytes, the manifest records ${String(artifact.bytes)}`,
      );
    }
    if (actual.sha256 !== artifact.sha256) {
      problems.push(`${artifact.file} does not match its SHA-256 checksum`);
    }
  }
  const named = new Set(manifest.artifacts.map(({ file }) => file));
  for (const file of checksums.keys()) {
    if (!named.has(file)) {
      problems.push(
        `${backupFiles.checksums} lists ${file}, which the manifest does not`,
      );
    }
  }
  return problems;
};
