import { z } from 'zod';

import {
  type DirectusRequest,
  DirectusRequestError,
} from '../directus-request.js';
import {
  type LedgerPlan,
  LedgerRefusalError,
  type LedgerRow,
  type MigrationStep,
  rowSchema,
} from './ledger-types.js';

export const ledgerCollection = 'migration_ledger';

export const ledgerPath = `/items/${ledgerCollection}`;

// The run token and status a ledger row is expected to carry.
export type Owner = Pick<LedgerRow, 'id' | 'run_token' | 'status'>;

const json = (body: unknown, method: 'PATCH' | 'POST') => ({
  body: JSON.stringify(body),
  method,
});

const idRows = z.array(rowSchema.pick({ id: true }));
const ownerSchema = rowSchema.pick({ id: true, run_token: true, status: true });

// A compare-and-set on one ledger row: Directus applies `data` to the rows
// matching the filter and returns them, so an empty result means the row no
// longer carries the run token and status this run last saw. Every write
// after a step's first claim goes through it, which fences a run whose step
// another run took over instead of letting both write.
export const fencedPatch = async (
  request: DirectusRequest,
  owner: Owner,
  data: Readonly<Record<string, unknown>>,
): Promise<boolean> => {
  const updated = idRows.parse(
    await request(
      `${ledgerPath}?fields=id`,
      json(
        {
          data,
          query: {
            filter: {
              id: { _eq: owner.id },
              run_token: { _eq: owner.run_token },
              status: { _eq: owner.status },
            },
            limit: 1,
          },
        },
        'PATCH',
      ),
    ),
  );
  return updated.length === 1;
};

export const takenOver = (
  plan: LedgerPlan,
  step: MigrationStep,
  what: string,
): LedgerRefusalError =>
  new LedgerRefusalError(
    `Step ${step.step} of ${plan.version} was ${what} by another run; only one migration run may be active. Inspect the ledger before continuing.`,
  );

export const refuse = (
  plan: LedgerPlan,
  step: MigrationStep,
  existing: LedgerRow,
): void => {
  if (existing.source_fingerprint !== plan.sourceFingerprint) {
    throw new LedgerRefusalError(
      `Step ${step.step} of ${plan.version} is recorded ${existing.status} against source fingerprint ${existing.source_fingerprint}, but the current source fingerprint is ${plan.sourceFingerprint}: the source changed since that run. Resolve the drift (or start a new migration version) instead of continuing.`,
    );
  }
  if (existing.status === 'running' && !plan.resume) {
    throw new LedgerRefusalError(
      `Step ${step.step} of ${plan.version} is recorded running by run ${existing.run_token} since ${existing.started_at}; another run may still hold it. Make sure no other run is active, then pass --resume to take it over.`,
    );
  }
};

const claimed = (plan: LedgerPlan) => ({
  error: null,
  finished_at: null,
  run_token: plan.runToken,
  started_at: plan.now(),
  status: 'running',
});

type Claim = {
  readonly plan: LedgerPlan;
  readonly step: MigrationStep;
};

// Re-claims a recorded step only if it still looks as this run read it,
// then reads the row back: two runs re-claiming one failed step both pass
// the read, but only the first conditional update matches and the other
// refuses instead of executing the step a second time.
const reclaim = async (
  request: DirectusRequest,
  { plan, step }: Claim,
  existing: LedgerRow,
): Promise<number> => {
  const taken = await fencedPatch(request, existing, claimed(plan));
  const owner = taken
    ? ownerSchema.parse(
        await request(
          `${ledgerPath}/${String(existing.id)}?fields=id,run_token,status`,
        ),
      )
    : null;
  if (owner?.run_token !== plan.runToken || owner.status !== 'running') {
    throw takenOver(plan, step, 'claimed at the same moment');
  }
  return existing.id;
};

// Claims a step that was never recorded: the unique key turns a concurrent
// claim into RECORD_NOT_UNIQUE, so exactly one run holds a new step.
const create = async (
  request: DirectusRequest,
  { plan, step }: Claim,
): Promise<number> => {
  try {
    const created = rowSchema.pick({ id: true }).parse(
      await request(
        ledgerPath,
        json(
          {
            ...claimed(plan),
            id_map: null,
            key: `${plan.version}/${step.step}`,
            source_fingerprint: plan.sourceFingerprint,
            step: step.step,
            version: plan.version,
          },
          'POST',
        ),
      ),
    );
    return created.id;
  } catch (error) {
    if (
      error instanceof DirectusRequestError &&
      error.code === 'RECORD_NOT_UNIQUE'
    ) {
      throw takenOver(plan, step, 'claimed at the same moment');
    }
    throw error;
  }
};

export const claim = (
  request: DirectusRequest,
  target: Claim,
  existing: LedgerRow | undefined,
): Promise<number> =>
  existing === undefined
    ? create(request, target)
    : reclaim(request, target, existing);
