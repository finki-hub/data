import type { ActionContext } from './action-support.js';
import type { Fingerprints } from './fingerprint.js';
import type { HistorySummary } from './history-port.js';

import { isClaimStale, pendingDomains, upstreamOf } from './decisions.js';
import { coordinationDomains, type Domain, isDomain } from './domains.js';
import { blockingFailure } from './failures.js';
import { type OperationsState } from './state.js';

export type DomainState = 'current' | 'failed' | 'pending' | 'running';

export type DomainStatus = {
  readonly current: boolean;
  readonly failed: boolean;
  readonly pending: boolean;
  readonly running: boolean;
  readonly state: DomainState;
  readonly waitingFor: readonly Domain[];
};

// One domain as an operator needs it: `current` is true only while the
// domain is neither dirty nor behind the managed Flow graph, so its derived
// rows are those of the latest source revision; `failed` only while a
// failure at its current inputs and graph holds it back (an edit of a
// table it reads, Mark pending or a graph change lifts it, and the domain
// turns pending); `waitingFor` names the pending upstream domains it runs
// after. A failed or interrupted history run leaves history_index not
// current: its index is stale until a run completes.
type DomainView = {
  readonly fingerprints: Fingerprints;
  readonly pending: readonly Domain[];
  readonly state: OperationsState;
};

type StatusInput = {
  readonly candidates: number;
  readonly context: ActionContext;
  readonly fingerprints: Fingerprints;
  readonly historyIndex: HistorySummary;
  readonly state: OperationsState;
};

const domainStatus = (
  { fingerprints, pending, state }: DomainView,
  domain: Domain,
): DomainStatus => {
  const running = state.claim?.domain === domain;
  const isPending = pending.includes(domain);
  // A failure holds back pending work only: once a later run (an explicit
  // retry at the same revision) completed the domain, it is current.
  const failed =
    isPending && blockingFailure(state, domain, fingerprints) !== null;
  let status: DomainState = 'current';
  if (running) {
    status = 'running';
  } else if (failed) {
    status = 'failed';
  } else if (isPending) {
    status = 'pending';
  }
  return {
    current: !isPending,
    failed,
    pending: isPending,
    running,
    state: status,
    waitingFor: upstreamOf(domain).filter((upstream) =>
      pending.includes(upstream),
    ),
  };
};

// The last failure with its revision, message and whether it still blocks
// its domain; it stays recorded after a later success, so `blocking` (not
// its mere presence) says whether it matters now: only while its domain
// is pending.
const lastErrorOf = ({ fingerprints, pending, state }: DomainView) => {
  const error = state.lastError;
  if (error === null) {
    return null;
  }
  return {
    at: error.at,
    blocking:
      isDomain(error.domain) &&
      pending.includes(error.domain) &&
      blockingFailure(state, error.domain, fingerprints) !== null,
    code: error.code,
    domain: error.domain,
    message: error.message,
    revision: error.revision,
  };
};

const statusOf = ({
  candidates,
  context,
  fingerprints,
  historyIndex,
  state,
}: StatusInput) => {
  const pending = pendingDomains(state, fingerprints);
  const view = { fingerprints, pending, state };
  return {
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
    // One entry per declared domain, in dependency order.
    domains: Object.fromEntries(
      coordinationDomains.map((domain) => [domain, domainStatus(view, domain)]),
    ),
    // The accepted fingerprint of each kind (the last completed run's) and
    // the current one of each graph.
    fingerprints: {
      calculation: state.calculationFingerprint,
      current: fingerprints,
      publication: state.publicationFingerprint,
    },
    // The derived index against the raw snapshot: users whose distinct
    // indexed entries differ from the scraper's `Courses Count` are
    // counted, never listed, and the scraper field is never rewritten.
    historyIndex,
    importState: state.importState,
    lastError: lastErrorOf(view),
    lastRun: { finishedAt: state.finishedAt, startedAt: state.startedAt },
    pending,
    process: context.owner,
    publication: {
      files: state.publicationOutcomes,
      state: state.publicationState,
    },
    revisions: {
      completed: state.completedRevision,
      // The last change to each calculation's inputs; a run claimed at or
      // after it is not overtaken by later publication-only edits.
      inputs: state.inputRevisions,
      requested: state.requestedRevision,
      source: state.sourceRevision,
    },
    staleAfterMs: context.staleAfterMs,
  };
};

export type StatusReport = ReturnType<typeof statusOf>;

// The bounded status: no token, no candidate rows, no payloads. Unlike a
// claim it reads the history index summary (aggregates over the Moodle
// users and entries), so the scheduled Flow never calls it.
export const statusAction = (context: ActionContext): Promise<StatusReport> =>
  context.store.transaction(async (port) => {
    await port.ensureSingleton();
    const state = await port.readState(false);
    const fingerprints = await port.currentFingerprints();
    const candidates =
      state.claim === null ? 0 : await port.candidateCount(state.claim.token);
    const historyIndex = await port.history.summary();
    return statusOf({ candidates, context, fingerprints, historyIndex, state });
  });
