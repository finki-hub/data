import type { ReadinessEntry } from './readiness-types.js';
import type { ExportDefinition } from './types.js';

import { calculationDomains } from '../coordination/domains.js';
import { checkDefinitions } from './definitions-check.js';
import {
  fileKeys,
  type PreparedFile,
  readFileSources,
  serializeFile,
  type SourceReader,
  validateFile,
} from './engine.js';
import { exportError } from './errors.js';
import { type CoordinationFacts } from './readiness-facts.js';
import { readinessRegistry } from './readiness-registry.js';
import {
  assessReadiness,
  type ReadinessAnswer,
  type ReadinessDeps,
} from './readiness.js';

// The two actions of the export operation over a list of definitions:
// readiness alone, and the preparation of every file (readiness first,
// then every file read, serialized and validated, then the source
// revision again). Nothing is uploaded here; a publication runs the same
// preparation and uploads the prepared bodies file by file.

export type Durations = {
  readonly read: number;
  readonly serialize: number;
  readonly total: number;
  readonly validate: number;
};

export type ExportDeps = ReadinessDeps & {
  // A monotonic clock in milliseconds, for the durations of the answer.
  readonly now: () => number;
};

export type Preparation = {
  readonly durationMs: Durations;
  readonly files: readonly PreparedFile[];
  readonly revision: number;
  readonly warnings: readonly string[];
};

// Readiness alone, over the readiness-check registry (the shipped one
// unless a test names another).
export const readinessAction = async (
  definitions: readonly ExportDefinition[],
  deps: ReadinessDeps,
  registry: readonly ReadinessEntry[] = readinessRegistry,
): Promise<ReadinessAnswer> => {
  checkDefinitions(definitions, registry);
  const { answer } = await assessReadiness(deps, registry);
  return answer;
};

// Reads, serializes and validates every file in order; each file's
// sources are released before the next file is read.
export const prepareFiles = async (
  definitions: readonly ExportDefinition[],
  reader: SourceReader,
  now: () => number,
) => {
  const spent = { read: 0, serialize: 0, validate: 0 };
  const files: PreparedFile[] = [];
  for (const definition of definitions) {
    let mark = now();
    const lap = (stage: keyof typeof spent) => {
      const next = now();
      spent[stage] += next - mark;
      mark = next;
    };
    const sources = await readFileSources(definition, reader);
    lap('read');
    const payload = serializeFile(definition, sources);
    lap('serialize');
    files.push(
      validateFile(definition, payload, {
        keys: fileKeys(definition, sources),
        rows: sources.rows.length,
      }),
    );
    lap('validate');
  }
  return { files, spent };
};

const notReady = (answer: ReadinessAnswer) =>
  exportError(
    'NOT_READY',
    `Not ready at source revision ${answer.revision}: ${answer.blockers
      .map((code) => `${code} ${answer.issueCounts[code] ?? 0}`)
      .join(
        ', ',
      )}. Nothing was prepared; "Data / Validate readiness" lists every issue with its Studio page.`,
    {
      blockers: answer.blockers,
      issueCounts: answer.issueCounts,
      revision: answer.revision,
    },
  );

// The preparation is kept only when nothing it read can have moved: the
// same source revision, the same accepted calculation, and both
// calculations still current (a Flow graph change makes them pending
// without moving the source revision).
const isStable = (
  before: CoordinationFacts,
  after: CoordinationFacts,
): boolean =>
  after.revision === before.revision &&
  after.calculation === before.calculation &&
  calculationDomains.every((domain) => after.domains[domain] === 'current');

const unstable = (before: CoordinationFacts, after: CoordinationFacts) => {
  const states = calculationDomains
    .map((domain) => [domain, after.domains[domain] ?? 'unknown'].join(' '))
    .join(', ');
  return exportError(
    'UNSTABLE_PREPARATION',
    `The source changed while the public files were prepared (source revision ${before.revision}, now ${after.revision}; calculations ${states}); nothing was prepared. Prepare again.`,
    { revision: after.revision, revisionBefore: before.revision },
  );
};

const rounded = (milliseconds: number): number => Math.round(milliseconds);

// Readiness, then every file, then the revision again: a preparation that
// is not ready is refused before any file is read, and one the source
// changed under is refused before anything is answered.
export const preparePublicFiles = async (
  definitions: readonly ExportDefinition[],
  deps: ExportDeps,
  registry: readonly ReadinessEntry[] = readinessRegistry,
): Promise<Preparation> => {
  checkDefinitions(definitions, registry);
  const started = deps.now();
  const { answer, coordination } = await assessReadiness(deps, registry);
  if (!answer.ready) {
    throw notReady(answer);
  }
  const { files, spent } = await prepareFiles(
    definitions,
    deps.reader,
    deps.now,
  );
  const after = await deps.coordination();
  if (!isStable(coordination, after)) {
    throw unstable(coordination, after);
  }
  return {
    durationMs: {
      read: rounded(spent.read),
      serialize: rounded(spent.serialize),
      total: rounded(deps.now() - started),
      validate: rounded(spent.validate),
    },
    files,
    revision: answer.revision,
    warnings: answer.warnings,
  };
};

// The bounded answer of the prepare action: per file its name, rows, UTF-8
// bytes and the sha256 of its body; never a payload.
export const prepareAction = async (
  definitions: readonly ExportDefinition[],
  deps: ExportDeps,
  registry: readonly ReadinessEntry[] = readinessRegistry,
) => {
  const prepared = await preparePublicFiles(definitions, deps, registry);
  return {
    durationMs: prepared.durationMs,
    files: prepared.files.map(({ bytes, filename, rows, sha256 }) => ({
      bytes,
      filename,
      rows,
      sha256,
    })),
    revision: prepared.revision,
    warnings: prepared.warnings,
  };
};
