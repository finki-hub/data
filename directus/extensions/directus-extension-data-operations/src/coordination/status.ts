import type { ActionContext } from './action-support.js';
import type { HistorySummary } from './history-port.js';
import type { OperationsState } from './state.js';

import { isClaimStale, pendingDomains } from './decisions.js';

type StatusInput = {
  readonly candidates: number;
  readonly context: ActionContext;
  readonly fingerprint: string;
  readonly historyIndex: HistorySummary;
  readonly state: OperationsState;
};

const statusOf = ({
  candidates,
  context,
  fingerprint,
  historyIndex,
  state,
}: StatusInput) => ({
  candidates,
  claim:
    state.claim === null
      ? null
      : {
          domain: state.claim.domain,
          heartbeatAgeMs: Math.round(state.claim.heartbeatAgeMs),
          heartbeatAt: state.claim.heartbeatAt,
          ownedByThisProcess: state.claim.owner === context.owner,
          owner: state.claim.owner,
          pages: state.claim.pages?.length ?? null,
          revision: state.claim.revision,
          staged: state.claim.staged.length,
          stale: isClaimStale(state.claim, context.staleAfterMs),
          startedAt: state.claim.startedAt,
        },
  dirty: state.dirtyDomains,
  fingerprints: {
    calculation: state.calculationFingerprint,
    current: fingerprint,
    publication: state.publicationFingerprint,
  },
  // The derived index against the raw snapshot: users whose distinct
  // indexed entries differ from the scraper's `Courses Count` are counted,
  // never listed, and the scraper field is never rewritten.
  historyIndex,
  importState: state.importState,
  lastError:
    state.lastError === null
      ? null
      : {
          at: state.lastError.at,
          code: state.lastError.code,
          domain: state.lastError.domain,
          revision: state.lastError.revision,
        },
  lastRun: { finishedAt: state.finishedAt, startedAt: state.startedAt },
  pending: pendingDomains(state, fingerprint),
  process: context.owner,
  publication: { files: state.publishedFiles, state: state.publicationState },
  revisions: {
    completed: state.completedRevision,
    requested: state.requestedRevision,
    source: state.sourceRevision,
  },
  staleAfterMs: context.staleAfterMs,
});

export type StatusReport = ReturnType<typeof statusOf>;

// The bounded status: no token, no candidate rows, no payloads.
export const statusAction = (context: ActionContext): Promise<StatusReport> =>
  context.store.transaction(async (port) => {
    await port.ensureSingleton();
    const state = await port.readState(false);
    const fingerprint = await port.currentFingerprint();
    const candidates =
      state.claim === null ? 0 : await port.candidateCount(state.claim.token);
    const historyIndex = await port.history.summary();
    return statusOf({ candidates, context, fingerprint, historyIndex, state });
  });
