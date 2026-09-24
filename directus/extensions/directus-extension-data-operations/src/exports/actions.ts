import { z } from 'zod';

import type { ExportDefinition } from './types.js';

import { maxPublishedFiles } from '../coordination/state.js';
import { exportActions } from './action-names.js';
import { exportError } from './errors.js';
import { exportDefinitions } from './index.js';
import { type ExportDeps, prepareAction, readinessAction } from './prepare.js';
import { outcomesAction, stageAction } from './publication.js';

export const exportsOperationId = 'finki-hub-exports';

// readiness answers whether the public files can be prepared now; prepare
// also reads, serializes and validates every file and answers their sizes
// and digests; stage does the same for the publication that holds the
// claim of this revision and hands one upload per file to the publish
// loop; outcomes folds the loop's answers into one outcome per file. None
// uploads anything.
const optionsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('readiness') }),
  z.object({ action: z.literal('prepare') }),
  z.object({
    action: z.literal('stage'),
    revision: z.coerce.number().int().nonnegative(),
    token: z.uuid(),
  }),
  z.object({
    action: z.literal('outcomes'),
    results: z.array(z.unknown()).max(maxPublishedFiles),
  }),
]);

// The Studio form and the schema name the same actions.
export const parsedActions = optionsSchema.options.map(
  (option) => option.shape.action.value,
);

const adminAccountability = z.object({ admin: z.literal(true) });

// The operation serves administrators only, whatever the Flow around it
// checks: it reads with system rights.
export const requireAdmin = (accountability: unknown): void => {
  if (!adminAccountability.safeParse(accountability).success) {
    throw exportError(
      'FORBIDDEN',
      'Only administrators may check, prepare or publish the public files.',
    );
  }
};

export const parseExportOptions = (
  options: unknown,
): z.infer<typeof optionsSchema> => {
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) {
    throw exportError(
      'INVALID_OPTIONS',
      `Invalid export options. Actions: ${exportActions.join(', ')}.`,
    );
  }
  return parsed.data;
};

export type ExportCaller = {
  readonly accountability: unknown;
  readonly definitions?: readonly ExportDefinition[];
  // Builds the reader and the status sources, only once the caller and
  // the options are accepted.
  readonly deps: () => Promise<ExportDeps>;
};

export const runExportAction = async (
  options: unknown,
  { accountability, definitions = exportDefinitions, deps }: ExportCaller,
) => {
  requireAdmin(accountability);
  const parsed = parseExportOptions(options);
  if (parsed.action === 'outcomes') {
    return outcomesAction(definitions, parsed.results);
  }
  const built = await deps();
  if (parsed.action === 'stage') {
    return stageAction({ claim: parsed, definitions, deps: built });
  }
  return parsed.action === 'readiness'
    ? readinessAction(definitions, built)
    : prepareAction(definitions, built);
};
