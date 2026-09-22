import type { LedgerSummary } from './report.js';

import {
  type DirectusRequest,
  DirectusRequestError,
} from '../directus-request.js';
import {
  claim,
  fencedPatch,
  ledgerCollection,
  ledgerPath,
  type Owner,
  refuse,
  takenOver,
} from './ledger-claim.js';
import {
  type LedgerOutcome,
  type LedgerPlan,
  LedgerRefusalError,
  type LedgerRow,
  LedgerStepError,
  type MigrationStep,
  rowSchema,
} from './ledger-types.js';
import { readAll } from './paging.js';
import { mergeSourceMap, type SourceMapEntry } from './source-map.js';

export const readLedger = async (
  request: DirectusRequest,
  version: string,
): Promise<readonly LedgerRow[]> => {
  const rows = await readAll(request, {
    fields: Object.keys(rowSchema.shape),
    pathname: ledgerPath,
    schema: rowSchema,
  });
  return rows.filter((row) => row.version === version);
};

// Null when the ledger collection is not installed, which Directus reports
// as a permission failure.
export const readLedgerOrNull = async (
  request: DirectusRequest,
  version: string,
): Promise<null | readonly LedgerRow[]> => {
  try {
    return await readLedger(request, version);
  } catch (error) {
    if (error instanceof DirectusRequestError && error.code === 'FORBIDDEN') {
      return null;
    }
    throw error;
  }
};

export const summarizeLedger = (rows: readonly LedgerRow[]): LedgerSummary => ({
  completed: rows
    .filter(({ status }) => status === 'completed')
    .map(({ step }) => step),
  failed: rows
    .filter(({ status }) => status === 'failed')
    .map(({ step }) => step),
  running: rows
    .filter(({ status }) => status === 'running')
    .map(({ step }) => step),
});

type Claimed = {
  readonly existing: LedgerRow | undefined;
  readonly owner: Owner;
  readonly plan: LedgerPlan;
  readonly step: MigrationStep;
};

// Runs one claimed step: entries recorded mid-step and the completion are
// written only while this run still holds the row, a throwing step is
// recorded failed and rethrown, and a refusal raised inside the step (a
// fenced write) passes through untouched.
const execute = async (
  request: DirectusRequest,
  { existing, owner, plan, step }: Claimed,
): Promise<void> => {
  let recorded = existing?.id_map ?? [];
  const write = async (
    data: Readonly<Record<string, unknown>>,
    what: string,
  ): Promise<void> => {
    if (!(await fencedPatch(request, owner, data))) {
      throw takenOver(plan, step, what);
    }
  };
  let entries: readonly SourceMapEntry[];
  try {
    entries = await step.run({
      previous: recorded,
      record: async (items) => {
        recorded = mergeSourceMap(recorded, items);
        await write(
          { id_map: recorded },
          'taken over while it recorded its id map',
        );
      },
      request,
      sourceFingerprint: plan.sourceFingerprint,
    });
  } catch (error) {
    if (error instanceof LedgerRefusalError) {
      throw error;
    }
    await fencedPatch(request, owner, {
      error: error instanceof Error ? error.message : String(error),
      finished_at: plan.now(),
      status: 'failed',
    });
    throw new LedgerStepError(step.step, { cause: error });
  }
  await write(
    {
      finished_at: plan.now(),
      id_map: mergeSourceMap(recorded, entries),
      status: 'completed',
    },
    'taken over while it ran, so its result was not recorded',
  );
};

// Runs the steps in order against the versioned ledger: a completed step is
// skipped, a failed or (with --resume) interrupted step is re-claimed with
// its recorded id map, a step under a different source fingerprint refuses,
// the unique key lets exactly one run claim a new step, and a conditional
// update lets exactly one run re-claim a recorded one.
export const runLedger = async (
  request: DirectusRequest,
  plan: LedgerPlan,
): Promise<LedgerOutcome> => {
  const rows = await readLedgerOrNull(request, plan.version);
  if (rows === null) {
    throw new LedgerRefusalError(
      `The ledger collection ${ledgerCollection} does not exist; run npm run setup against this project first.`,
    );
  }
  const completed: string[] = [];
  const skipped: string[] = [];
  for (const step of plan.steps) {
    const existing = rows.find((row) => row.step === step.step);
    if (existing !== undefined) {
      refuse(plan, step, existing);
      if (existing.status === 'completed') {
        skipped.push(step.step);
        continue;
      }
    }
    const id = await claim(request, { plan, step }, existing);
    await execute(request, {
      existing,
      owner: { id, run_token: plan.runToken, status: 'running' },
      plan,
      step,
    });
    completed.push(step.step);
  }
  return { completed, skipped };
};
