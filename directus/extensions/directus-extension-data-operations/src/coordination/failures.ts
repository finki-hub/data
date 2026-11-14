import type { Fingerprints } from './fingerprint.js';

import {
  type ClaimDomain,
  coordinationDomains,
  type Domain,
  isCalculation,
  kindOf,
} from './domains.js';
import { type Claim, type LastError, type OperationsState } from './state.js';

// The source revision of the last change a run of this domain depends on.
// A calculation reads only the tables that mark it or an upstream domain,
// so its own input revision decides; a snapshot promotion reads
// everything, so every source statement counts for it.
export const inputRevision = (
  state: OperationsState,
  domain: ClaimDomain | null,
): number =>
  isCalculation(domain) ? state.inputRevisions[domain] : state.sourceRevision;

// A run overtaken by a source or graph change was discarded, not failed:
// it never blocks the rerun that the overtaking asks for.
const overtakingCodes: readonly string[] = [
  'SOURCE_CHANGED',
  'FINGERPRINT_CHANGED',
];

// A calculation claim released because it stopped heartbeating (a restart
// or a crash mid-run) the first time at its inputs: the schedule runs the
// domain once more on its own.
export const interruptedCode = 'CLAIM_INTERRUPTED';

// Any other abandoned claim: a calculation interrupted again at the same inputs and graph (a crash loop). It blocks
// until an explicit retry, Mark pending, an edit or a graph change.
export const abandonedCode = 'CLAIM_ABANDONED';

const rerunCodes: ReadonlySet<string> = new Set([
  ...overtakingCodes,
  interruptedCode,
]);

// Whether a recorded failure still describes the domain's current work:
// the same domain and graph fingerprint, and no change to the domain's
// inputs since the failed claim was taken.
const describesCurrentInputs = (
  state: OperationsState,
  error: LastError,
  work: { readonly domain: ClaimDomain | null; readonly fingerprint: string },
): boolean =>
  error.domain === work.domain &&
  error.fingerprint === work.fingerprint &&
  error.revision !== null &&
  inputRevision(state, work.domain) <= error.revision;

// The failure that keeps a domain from running on its own: a genuine
// failure (not an overtaking or a first interruption) of that domain at
// its current inputs and at the current fingerprint of its kind. A change
// to its inputs (an edit of a table it reads, or mark, which is the
// explicit retry of the scheduled path), a changed graph of its kind or
// `retry` lifts it; an edit that only marks publication does not, and time
// alone never does.
export const blockingFailure = (
  state: OperationsState,
  domain: Domain,
  current: Fingerprints,
): LastError | null => {
  const error = state.lastError;
  if (
    error === null ||
    rerunCodes.has(error.code) ||
    !describesCurrentInputs(state, error, {
      domain,
      fingerprint: current[kindOf(domain)],
    })
  ) {
    return null;
  }
  return error;
};

// The code an abandoned claim is released with: a calculation's first
// interruption at its inputs reruns by itself, a second one in a row (the
// last failure is that interruption, and neither the inputs nor the graph
// changed since) blocks, so a crash loop stops after one automatic retry.
export const abandonmentCode = (
  state: OperationsState,
  claim: Claim,
): string => {
  const error = state.lastError;
  const calculation = isCalculation(claim.domain);
  const repeated =
    error?.code === interruptedCode &&
    describesCurrentInputs(state, error, claim);
  return calculation && !repeated ? interruptedCode : abandonedCode;
};

// Whether a statement or mark that marks these domains touches the inputs
// of a calculation: it marks the calculation itself or an upstream domain
// (the enrollment counts read the history index).
export const touchesInputs = (
  marked: readonly Domain[],
  calculation: Domain,
): boolean =>
  coordinationDomains
    .slice(0, coordinationDomains.indexOf(calculation) + 1)
    .some((domain) => marked.includes(domain));
