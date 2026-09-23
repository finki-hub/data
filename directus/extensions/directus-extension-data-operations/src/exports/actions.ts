import { z } from 'zod';

import type { ExportDefinition } from './types.js';

import { exportError } from './errors.js';
import { exportDefinitions } from './index.js';
import { type ExportDeps, prepareAction, readinessAction } from './prepare.js';

export const exportsOperationId = 'finki-hub-exports';

// readiness answers whether the public files can be prepared now;
// prepare also reads, serializes and validates every file and answers
// their sizes and digests. Neither uploads anything.
export const exportActions = ['readiness', 'prepare'] as const;

const optionsSchema = z.object({ action: z.enum(exportActions) });

const adminAccountability = z.object({ admin: z.literal(true) });

// The operation serves administrators only, whatever the Flow around it
// checks: it reads with system rights.
export const requireAdmin = (accountability: unknown): void => {
  if (!adminAccountability.safeParse(accountability).success) {
    throw exportError(
      'FORBIDDEN',
      'Only administrators may check or prepare the public files.',
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
  const { action } = parseExportOptions(options);
  return action === 'readiness'
    ? readinessAction(definitions, await deps())
    : prepareAction(definitions, await deps());
};
