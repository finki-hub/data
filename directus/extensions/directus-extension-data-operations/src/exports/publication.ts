import { z } from 'zod';

import type { ReadinessEntry } from './readiness-types.js';
import type { ExportDefinition } from './types.js';

import { fileOutcomes } from '../coordination/domains.js';
import { boundedCode } from '../coordination/outcomes.js';
import { exportError } from './errors.js';
import { type ExportDeps, preparePublicFiles } from './prepare.js';
import { readinessRegistry } from './readiness-registry.js';

// The publication side of the export operation. `stage` prepares every
// declared file for a publication that holds its claim (readiness, reads,
// serialization and validation of every file before the first upload,
// then the source revision against the claim's) and answers one upload per
// file, in definition order, for the native publish loop. `outcomes` folds
// the loop's answers into one outcome per declared file. Neither uploads.

// The stage's answer beside the prepare summary: each file's single-entry
// objects map for the existing storage writer, its digest, and the claim
// token its child keeps alive.
export const stageAction = async ({
  claim,
  definitions,
  deps,
  registry = readinessRegistry,
}: {
  readonly claim: { readonly revision: number; readonly token: string };
  readonly definitions: readonly ExportDefinition[];
  readonly deps: ExportDeps;
  readonly registry?: readonly ReadinessEntry[];
}) => {
  const prepared = await preparePublicFiles(definitions, deps, registry);
  if (prepared.revision !== claim.revision) {
    throw exportError(
      'UNSTABLE_PREPARATION',
      `The source changed after the publication was claimed (claimed at source revision ${claim.revision}, prepared at ${prepared.revision}); nothing was uploaded. Publish again.`,
      { revision: prepared.revision, revisionBefore: claim.revision },
    );
  }
  return {
    durationMs: prepared.durationMs,
    files: prepared.files.map(({ bytes, filename, rows, sha256 }) => ({
      bytes,
      filename,
      rows,
      sha256,
    })),
    revision: prepared.revision,
    uploads: prepared.files.map(({ body, bytes, filename, sha256 }) => {
      const payload: unknown = JSON.parse(body);
      return {
        bytes,
        claim: claim.token,
        filename,
        objects: { [filename]: payload },
        sha256,
      };
    }),
    warnings: prepared.warnings,
  };
};

// One child's answer as its transforms build it; anything else counts as
// no answer for its file.
const answerSchema = z.object({
  bytes: z.number().int().nonnegative().nullable().optional(),
  code: z.string().nullable().optional(),
  filename: z.string(),
  // Why the upload failed, as the writer said it (bounded there).
  message: z.string().optional(),
  ok: z.boolean(),
  outcome: z.enum(fileOutcomes),
});

type Answer = z.infer<typeof answerSchema>;

type FileOutcome =
  | { readonly bytes?: number; readonly outcome: 'uploaded' }
  | { readonly code: string; readonly outcome: 'failed' | 'skipped' };

// A child answered without a bounded code (an error that carried none, or
// a template the engine rendered as text): the upload still failed, and
// boundedCode records it as PUBLISH_FAILED.
const noAnswerCode = 'NO_ANSWER';
const shownFailures = 5;
const messageLength = 600;

const outcomeOf = (answer: Answer | undefined): FileOutcome => {
  if (answer === undefined) {
    return { code: noAnswerCode, outcome: 'failed' };
  }
  if (answer.ok && answer.outcome === 'uploaded') {
    return typeof answer.bytes === 'number'
      ? { bytes: answer.bytes, outcome: 'uploaded' }
      : { outcome: 'uploaded' };
  }
  return {
    code: boundedCode(answer.code ?? undefined),
    outcome: answer.outcome === 'skipped' ? 'skipped' : 'failed',
  };
};

const refuse = (message: string) =>
  exportError('INVALID_OPTIONS', `${message}; nothing was recorded.`);

// The answers keyed by filename, refusing a filename no definition
// declares or one answered twice (a publish Flow edited out of shape).
const answersOf = (
  declared: readonly string[],
  results: readonly unknown[],
): ReadonlyMap<string, Answer> => {
  const answers = new Map<string, Answer>();
  for (const result of results) {
    const parsed = answerSchema.safeParse(result);
    if (!parsed.success) {
      continue;
    }
    const { filename } = parsed.data;
    if (!declared.includes(filename)) {
      throw refuse(
        `The publish loop answered for ${filename.slice(0, 80)}, which no export definition declares`,
      );
    }
    if (answers.has(filename)) {
      throw refuse(`The publish loop answered twice for ${filename}`);
    }
    answers.set(filename, parsed.data);
  }
  return answers;
};

// The summary the parent records: ok only when every declared file was
// uploaded; otherwise PUBLICATION_PARTIAL (some uploaded) or
// PUBLICATION_FAILED (none), naming the files not uploaded with their
// codes and the first failure's message.
export const outcomesAction = (
  definitions: readonly ExportDefinition[],
  results: readonly unknown[],
) => {
  const declared = definitions.map(({ filename }) => filename);
  const answers = answersOf(declared, results);
  const files = Object.fromEntries(
    declared.map((filename) => [filename, outcomeOf(answers.get(filename))]),
  );
  const uploaded = declared.filter(
    (filename) => files[filename]?.outcome === 'uploaded',
  );
  const failed = declared.filter((filename) => !uploaded.includes(filename));
  if (failed.length === 0) {
    return {
      code: null,
      failed,
      files,
      message: `Uploaded every declared file: ${uploaded.join(', ')}.`,
      ok: true,
      uploaded,
    };
  }
  const failures = failed
    .slice(0, shownFailures)
    .map((filename) => {
      const entry = files[filename];
      return `${filename} (${entry !== undefined && 'code' in entry ? entry.code : noAnswerCode})`;
    })
    .join(', ');
  const cause = failed
    .map((filename) => answers.get(filename)?.message)
    .find((message) => message !== undefined && message !== '');
  const detail = cause === undefined ? '' : ` First failure: ${cause}`;
  return {
    code: uploaded.length > 0 ? 'PUBLICATION_PARTIAL' : 'PUBLICATION_FAILED',
    failed,
    files,
    message:
      `Uploaded ${uploaded.length} of ${declared.length} files; not uploaded: ${failures}. The source revision is not recorded as published; publish again.${detail}`.slice(
        0,
        messageLength,
      ),
    ok: false,
    uploaded,
  };
};
