import { z } from 'zod';

import { exportDefinitions } from '../exports/index.js';
import { publicFilenamePattern } from '../exports/types.js';
import {
  type ClaimDomain,
  type FileOutcome,
  fileOutcomes,
  type PublicationState,
} from './domains.js';
import { coordinationError } from './errors.js';
import { maxPublishedFiles } from './state.js';

// The per-file outcomes of a publication, keyed by the published filename:
// what `complete` and `fail` of a publication claim record in
// data_operations.publication_outcomes. The declared files are those of the
// export definitions, so a new definition adds an outcome and no column.

// The filenames a publication may report: every export definition's, in
// publication order.
export const declaredFilenames: readonly string[] = exportDefinitions.map(
  ({ filename }) => filename,
);

const outcomeCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;

// The code a failed or skipped file is recorded with when its step
// answered none that is bounded (an error without a code, or a template
// rendered as text).
const unboundedCode = 'PUBLISH_FAILED';

export const boundedCode = (code: string | undefined): string =>
  code !== undefined && outcomeCodePattern.test(code) ? code : unboundedCode;

// One file as the publication reports it: an uploaded file carries no
// code, a failed or skipped one the bounded code of its failure.
const fileOutcomeSchema = z
  .strictObject({
    bytes: z.number().int().nonnegative().nullable().optional(),
    code: z.string().regex(outcomeCodePattern).nullable().optional(),
    outcome: z.enum(fileOutcomes),
  })
  .refine(
    ({ code, outcome }) =>
      (outcome === 'uploaded') === (code === null || code === undefined),
    'an uploaded file carries no code; a failed or skipped file carries its code',
  );

export const filesSchema = z
  .record(z.string().regex(publicFilenamePattern), fileOutcomeSchema)
  .refine((files) => Object.keys(files).length <= maxPublishedFiles, {
    message: `At most ${maxPublishedFiles} files`,
  });

// One file as the coordinator keeps it: its outcome and code, the bytes
// written, and the source revision of the claim that attempted it, so an
// outcome kept across a later failure still says which revision it holds.
export type StoredOutcome = {
  readonly bytes: null | number;
  readonly code: null | string;
  readonly outcome: FileOutcome;
  readonly revision: number;
};

export type StoredOutcomes = Readonly<Record<string, StoredOutcome>>;

type ReportedOutcomes = z.infer<typeof filesSchema>;

export const storedOutcomeSchema = z.strictObject({
  bytes: z.number().int().nonnegative().nullable(),
  code: z.string().nullable(),
  outcome: z.enum(fileOutcomes),
  revision: z.number().int(),
});

export const withRevision = (
  files: ReportedOutcomes,
  revision: number,
): StoredOutcomes =>
  Object.fromEntries(
    Object.entries(files).map(([filename, { bytes, code, outcome }]) => [
      filename,
      { bytes: bytes ?? null, code: code ?? null, outcome, revision },
    ]),
  );

// Outcomes belong to a publication claim and name declared files only; a
// filename no export definition declares is refused before anything is
// written.
export const checkReportedFiles = (
  files: ReportedOutcomes | undefined,
  domain: ClaimDomain | null,
  declared: readonly string[],
): void => {
  if (files === undefined) {
    return;
  }
  if (domain !== 'publication') {
    throw coordinationError(
      'DOMAIN_MISMATCH',
      `Only a publication claim records file outcomes; this claim is ${domain ?? 'unknown'}.`,
      { status: 400 },
    );
  }
  const unknown = Object.keys(files).filter(
    (filename) => !declared.includes(filename),
  );
  if (unknown.length > 0) {
    throw coordinationError(
      'UNKNOWN_FILE',
      `No export definition declares ${unknown.slice(0, 5).join(', ')}; declared: ${declared.join(', ')}.`,
      { details: { unknown: unknown.slice(0, 5) }, status: 400 },
    );
  }
};

// A publication completes only when every declared file was uploaded:
// anything less is recorded through `fail`, never as a published revision.
export const requireEveryFileUploaded = (
  files: ReportedOutcomes | undefined,
  declared: readonly string[],
): void => {
  const missing = declared.filter(
    (filename) => files?.[filename]?.outcome !== 'uploaded',
  );
  if (missing.length > 0) {
    throw coordinationError(
      'OUTCOMES_INCOMPLETE',
      `A publication completes only when every declared file was uploaded; not uploaded: ${missing.slice(0, 5).join(', ')}. Record the outcomes with fail instead.`,
      { details: { missing: missing.slice(0, 5) } },
    );
  }
};

// The outcome map after one file's outcome is recorded: the entry replaces
// that file's earlier one (which may belong to an earlier run, and says so
// by its revision), in publication order.
export const mergedOutcomes = (
  stored: null | StoredOutcomes,
  recorded: StoredOutcomes,
  declared: readonly string[],
): StoredOutcomes => {
  const merged: StoredOutcomes = { ...stored, ...recorded };
  const order = [
    ...declared,
    ...Object.keys(merged).filter((filename) => !declared.includes(filename)),
  ];
  return Object.fromEntries(
    order.flatMap((filename) => {
      const entry = merged[filename];
      return entry === undefined ? [] : [[filename, entry]];
    }),
  );
};

// The publication state a released publication claim leaves, from the
// outcomes it holds (the map the release records, or else the one the
// publish loop recorded file by file): idle when a source or graph change
// overtook it, partial when a file was recorded uploaded at the claimed
// revision, failed when none was.
export const releasedPublicationState = (
  failed: boolean,
  files: null | StoredOutcomes | undefined,
  revision: null | number,
): PublicationState => {
  if (!failed) {
    return 'idle';
  }
  const uploaded = Object.values(files ?? {}).some(
    (entry) => entry.outcome === 'uploaded' && entry.revision === revision,
  );
  return uploaded ? 'partial' : 'failed';
};
