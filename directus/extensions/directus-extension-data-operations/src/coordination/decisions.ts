import { blockingFailure, inputRevision } from './failures.js';
import {
  calculationDomains,
  type Claim,
  type ClaimDomain,
  type ClaimTarget,
  coordinationDomains,
  type Domain,
  type LastError,
  nextCalculation,
  type OperationsState,
} from './state.js';

// The fingerprint of the last successful run of the domain's kind.
export const fingerprintFor = (
  state: OperationsState,
  domain: Domain,
): null | string =>
  domain === 'publication'
    ? state.publicationFingerprint
    : state.calculationFingerprint;

// A domain is pending while it is marked dirty or while the managed Flow
// graph no longer matches the graph its last successful run used.
export const pendingDomains = (
  state: OperationsState,
  currentFingerprint: string,
): Domain[] =>
  coordinationDomains.filter(
    (domain) =>
      state.dirtyDomains.includes(domain) ||
      fingerprintFor(state, domain) !== currentFingerprint,
  );

export const upstreamOf = (domain: Domain): readonly Domain[] =>
  coordinationDomains.slice(0, coordinationDomains.indexOf(domain));

export const isCalculation = (domain: Domain): boolean =>
  calculationDomains.includes(domain);

export const isClaimStale = (claim: Claim, staleAfterMs: number): boolean =>
  claim.heartbeatAgeMs > staleAfterMs;

// The claim a recovery must release: present and silent for longer than the
// documented window, whoever owns it.
export const abandonedClaim = (
  state: OperationsState,
  staleAfterMs: number,
): Claim | null =>
  state.claim !== null && isClaimStale(state.claim, staleAfterMs)
    ? state.claim
    : null;

export type ClaimDecision =
  | { readonly blocking: readonly Domain[]; readonly kind: 'upstream_dirty' }
  | { readonly claim: Claim; readonly kind: 'busy' }
  | {
      readonly dirtyDomains: readonly Domain[];
      readonly domain: Domain;
      readonly kind: 'claim';
    }
  | {
      readonly domain: Domain;
      readonly error: LastError;
      readonly kind: 'failed';
    }
  | { readonly kind: 'nothing_pending' };

export type ClaimRequest = {
  readonly currentFingerprint: string;
  readonly domain: ClaimTarget;
  readonly retry: boolean;
};

// The domain a claim names: itself while pending, or for next_calculation
// the first pending calculation domain in dependency order, so the
// scheduled Flow runs the history index before the enrollment counts and
// never publication.
const requestedDomain = (
  pending: readonly Domain[],
  target: ClaimTarget,
): Domain | null => {
  if (target === nextCalculation) {
    return (
      calculationDomains.find((domain) => pending.includes(domain)) ?? null
    );
  }
  return pending.includes(target) ? target : null;
};

// One job at a time: a present claim wins, then the domain must be pending,
// its upstream domains settled, and a failure at the domain's current
// inputs and graph must be retried explicitly (blockingFailure). A
// successful claim persists every pending domain as dirty, so a graph
// change marks its domains once and completion later clears only the
// claimed one.
export const decideClaim = (
  state: OperationsState,
  request: ClaimRequest,
): ClaimDecision => {
  if (state.claim !== null) {
    return { claim: state.claim, kind: 'busy' };
  }
  const pending = pendingDomains(state, request.currentFingerprint);
  const domain = requestedDomain(pending, request.domain);
  if (domain === null) {
    return { kind: 'nothing_pending' };
  }
  const blocking = upstreamOf(domain).filter((upstream) =>
    pending.includes(upstream),
  );
  if (blocking.length > 0) {
    return { blocking, kind: 'upstream_dirty' };
  }
  const error = request.retry
    ? null
    : blockingFailure(state, domain, request.currentFingerprint);
  if (error !== null) {
    return { domain, error, kind: 'failed' };
  }
  return { dirtyDomains: pending, domain, kind: 'claim' };
};

export type ClaimCheck = {
  readonly owner: string;
  readonly token: string;
};

export type OwnershipVerdict = 'claim_mismatch' | 'ok' | 'owner_mismatch';

export const verifyOwnership = (
  state: OperationsState,
  check: ClaimCheck,
): OwnershipVerdict => {
  if (state.claim?.token !== check.token) {
    return 'claim_mismatch';
  }
  return state.claim.owner === check.owner ? 'ok' : 'owner_mismatch';
};

export type ClaimVerdict = 'source_changed' | OwnershipVerdict;

// A claim is usable while its token and owner match and no source
// transaction that touched the claimed domain's inputs committed since it
// was taken; a publication or snapshot claim reads everything, so any
// source transaction counts for it.
export const verifyClaim = (
  state: OperationsState,
  check: ClaimCheck,
): ClaimVerdict => {
  const ownership = verifyOwnership(state, check);
  if (ownership !== 'ok' || state.claim === null) {
    return ownership === 'ok' ? 'claim_mismatch' : ownership;
  }
  return inputRevision(state, state.claim.domain) <= state.claim.revision
    ? 'ok'
    : 'source_changed';
};

export type StageDecision =
  | { readonly kind: 'ok' }
  | { readonly kind: 'page_unplanned' }
  | { readonly kind: Exclude<ClaimVerdict, 'ok'> };

export const decideStage = (
  state: OperationsState,
  check: ClaimCheck & { readonly page: string },
): StageDecision => {
  const verdict = verifyClaim(state, check);
  if (verdict !== 'ok') {
    return { kind: verdict };
  }
  return state.claim?.pages?.includes(check.page) === true
    ? { kind: 'ok' }
    : { kind: 'page_unplanned' };
};

export type CompletionDecision =
  | { readonly kind: 'fingerprint_changed' }
  | { readonly kind: 'ok' }
  | { readonly kind: 'pages_missing'; readonly missing: readonly string[] }
  | { readonly kind: 'unplanned' }
  | { readonly kind: Exclude<ClaimVerdict, 'ok'> };

// Output is accepted only when the claimed domain's inputs and the graph
// fingerprint still match the claim and a calculation run (history index
// or enrollments) planned its pages and staged every one of them; a
// partial batch, or a run that never planned, is never labelled current.
// A source without rows plans no page and completes.
export const decideCompletion = (
  state: OperationsState,
  check: ClaimCheck & { readonly currentFingerprint: string },
): CompletionDecision => {
  const verdict = verifyClaim(state, check);
  if (verdict !== 'ok' || state.claim === null) {
    return { kind: verdict === 'ok' ? 'claim_mismatch' : verdict };
  }
  if (state.claim.fingerprint !== check.currentFingerprint) {
    return { kind: 'fingerprint_changed' };
  }
  if (state.claim.domain === 'publication') {
    return { kind: 'ok' };
  }
  if (state.claim.pages === null) {
    return { kind: 'unplanned' };
  }
  const staged = new Set(state.claim.staged);
  const missing = state.claim.pages.filter((page) => !staged.has(page));
  return missing.length > 0
    ? { kind: 'pages_missing', missing }
    : { kind: 'ok' };
};

export const dirtyAfterCompletion = (
  state: OperationsState,
  domain: ClaimDomain | null,
): Domain[] => state.dirtyDomains.filter((dirty) => dirty !== domain);
