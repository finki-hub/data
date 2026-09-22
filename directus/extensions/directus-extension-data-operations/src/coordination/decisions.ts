import {
  calculationDomains,
  type Claim,
  coordinationDomains,
  type Domain,
  type LastError,
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
  | { readonly dirtyDomains: readonly Domain[]; readonly kind: 'claim' }
  | { readonly error: LastError; readonly kind: 'failed' }
  | { readonly kind: 'nothing_pending' };

export type ClaimRequest = {
  readonly currentFingerprint: string;
  readonly domain: Domain;
  readonly retry: boolean;
};

// A run overtaken by a source or graph change was discarded, not failed:
// it never blocks the rerun that the overtaking asks for.
export const overtakingCodes: readonly string[] = [
  'SOURCE_CHANGED',
  'FINGERPRINT_CHANGED',
];

const blockedByFailure = (
  state: OperationsState,
  request: ClaimRequest,
): LastError | null => {
  const error = state.lastError;
  if (
    request.retry ||
    error?.domain !== request.domain ||
    overtakingCodes.includes(error.code) ||
    error.revision !== state.sourceRevision ||
    error.fingerprint !== request.currentFingerprint
  ) {
    return null;
  }
  return error;
};

// One job at a time: a present claim wins, then the domain must be pending,
// its upstream domains settled, and a failure at this exact source and
// graph revision must be retried explicitly. A successful claim persists
// every pending domain as dirty, so a graph change marks its domains once
// and completion later clears only the claimed one.
export const decideClaim = (
  state: OperationsState,
  request: ClaimRequest,
): ClaimDecision => {
  if (state.claim !== null) {
    return { claim: state.claim, kind: 'busy' };
  }
  const pending = pendingDomains(state, request.currentFingerprint);
  if (!pending.includes(request.domain)) {
    return { kind: 'nothing_pending' };
  }
  const blocking = upstreamOf(request.domain).filter((domain) =>
    pending.includes(domain),
  );
  if (blocking.length > 0) {
    return { blocking, kind: 'upstream_dirty' };
  }
  const error = blockedByFailure(state, request);
  if (error !== null) {
    return { error, kind: 'failed' };
  }
  return { dirtyDomains: pending, kind: 'claim' };
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
// transaction committed since it was taken.
export const verifyClaim = (
  state: OperationsState,
  check: ClaimCheck,
): ClaimVerdict => {
  const ownership = verifyOwnership(state, check);
  if (ownership !== 'ok') {
    return ownership;
  }
  return state.claim?.revision === state.sourceRevision
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

// Output is accepted only when the source revision and the graph
// fingerprint still match the claim, and an enrollment run staged every
// page it planned; a partial batch is never labelled current.
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
  if (state.claim.domain !== 'enrollments') {
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
  domain: Domain | null,
): Domain[] => state.dirtyDomains.filter((dirty) => dirty !== domain);
