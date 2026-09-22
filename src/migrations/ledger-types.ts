import { z } from 'zod';

import type { DirectusRequest } from '../directus-request.js';

import { ledgerStatuses } from '../data-model/migration-collections.js';
import { type SourceMapEntry, sourceMapEntrySchema } from './source-map.js';

export const rowSchema = z.object({
  error: z.string().nullable(),
  finished_at: z.string().nullable(),
  id: z.number().int(),
  id_map: z.array(sourceMapEntrySchema).readonly().nullable(),
  key: z.string(),
  run_token: z.string(),
  source_fingerprint: z.string(),
  started_at: z.string(),
  status: z.enum(ledgerStatuses),
  step: z.string(),
  version: z.string(),
});

export type LedgerRow = z.infer<typeof rowSchema>;

// What a step receives. `previous` is the id map the ledger holds for the
// step: the entries an earlier attempt recorded through `record` or
// returned on completion, and empty after an interrupted attempt that
// recorded nothing. `record` persists entries mid-step so an interruption
// keeps them; it and the completion write refuse once another run has
// taken the step over. A step must still be idempotent through target-row
// provenance: the map is a convenience, not the guard against duplicates.
export type StepContext = {
  readonly previous: readonly SourceMapEntry[];
  readonly record: (entries: readonly SourceMapEntry[]) => Promise<void>;
  readonly request: DirectusRequest;
  readonly sourceFingerprint: string;
};

export type MigrationStep = {
  readonly run: (context: StepContext) => Promise<readonly SourceMapEntry[]>;
  readonly step: string;
};

export type LedgerPlan = {
  readonly now: () => string;
  readonly resume: boolean;
  readonly runToken: string;
  readonly sourceFingerprint: string;
  readonly steps: readonly MigrationStep[];
  readonly version: string;
};

export type LedgerOutcome = {
  readonly completed: readonly string[];
  readonly skipped: readonly string[];
};

export class LedgerRefusalError extends Error {
  public override readonly name = 'LedgerRefusalError';
}

export class LedgerStepError extends Error {
  public override readonly name = 'LedgerStepError';

  public constructor(
    public readonly step: string,
    options: ErrorOptions,
  ) {
    super(
      `Step ${step} failed: ${options.cause instanceof Error ? options.cause.message : String(options.cause)}`,
      options,
    );
  }
}
