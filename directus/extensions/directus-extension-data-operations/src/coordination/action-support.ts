import type { StoredOutcomes } from './outcomes.js';
import type { CoordinationPort, CoordinationStore } from './port.js';
import type { Claim, OperationsState } from './state.js';

import { retryingConflicts } from './conflict-retry.js';
import { abandonedClaim } from './decisions.js';
import { type CoordinationError, coordinationError } from './errors.js';
import { abandonmentCode, interruptedCode } from './failures.js';

export type ActionContext = {
  readonly owner: string;
  // The filenames a publication may report outcomes for, in publication
  // order; the export definitions' (declaredFilenames) when absent.
  readonly publishedFiles?: readonly string[];
  readonly staleAfterMs: number;
  readonly store: CoordinationStore;
};

// Why a claim was released without a caller left to receive a refusal
// (an abandoned claim), or when a change overtook its run: one template,
// `<Claim kind> <state>: <fact>`, plus a short statement of any state the
// outcome does not imply. An upload cannot be discarded, so a released
// publication says that its revision is not published.
const revisionUnpublished = 'Revision not published';

const released = (head: string, ...states: readonly string[]): string =>
  [head, ...states].join('. ');

const silence = (staleAfterMs: number): string =>
  `no heartbeat for ${String(Math.round(staleAfterMs / 1_000))} s`;

// The status of an abandoned publication keeps the outcome each file
// recorded; an upload running at that moment may have finished unrecorded.
export const abandonedPublicationMessage = (staleAfterMs: number): string =>
  released(
    `Publication claim abandoned: ${silence(staleAfterMs)}`,
    revisionUnpublished,
    'Last upload possibly unrecorded',
  );

const abandonmentMessage = (
  code: string,
  claim: Claim,
  staleAfterMs: number,
): string => {
  if (code === interruptedCode) {
    return released(
      `Claim interrupted: ${silence(staleAfterMs)}`,
      'Automatic rerun: once',
    );
  }
  return claim.domain === 'publication'
    ? abandonedPublicationMessage(staleAfterMs)
    : released(`Claim abandoned: ${silence(staleAfterMs)}`);
};

const overtakings: Readonly<Record<Overtaking, string>> = {
  fingerprint_changed: 'Flow graph changed',
  source_changed: 'Source changed',
};

// A run overtaken by a source or graph change; an overtaken publication
// keeps the outcome of each file it uploaded.
const overtakenMessage = (reason: Overtaking, publication: boolean): string =>
  publication
    ? released(`${overtakings[reason]} during publication`, revisionUnpublished)
    : `${overtakings[reason]} during run`;

export type Outcome<T> =
  Overtaken | { readonly kind: 'done'; readonly value: T };

type Mismatch = 'claim_mismatch' | 'owner_mismatch';

type Overtaken = {
  // The outcomes of an overtaken publication, kept with its release.
  readonly files?: StoredOutcomes;
  readonly kind: 'overtaken';
  readonly reason: Overtaking;
};

type Overtaking = 'fingerprint_changed' | 'source_changed';

export const done = <T>(value: T): Outcome<T> => ({ kind: 'done', value });

export const overtaken = (
  reason: Overtaking,
  files?: StoredOutcomes,
): Overtaken =>
  files === undefined
    ? { kind: 'overtaken', reason }
    : { files, kind: 'overtaken', reason };

export const unreachable = (value: never): never => {
  throw new TypeError(`Unexpected coordination case: ${String(value)}`);
};

export const mismatch = (verdict: Mismatch): CoordinationError =>
  verdict === 'claim_mismatch'
    ? coordinationError('CLAIM_MISMATCH', 'Claim token mismatch')
    : coordinationError(
        'OWNER_MISMATCH',
        'Claim owner mismatch: another Directus process',
      );

// Releases a claim whose run cannot be accepted any more. The failure
// details are kept for status; a plain overtaking (source or graph change)
// leaves the publication state idle, a real failure marks it failed. The
// singleton is written before the candidate rows so that every path locks
// the two in the same order.
export const releaseClaim = async (
  port: CoordinationPort,
  release: {
    readonly code: string;
    readonly failed: boolean;
    readonly files?: StoredOutcomes;
    readonly message: null | string;
    readonly token: string;
  },
): Promise<void> => {
  await port.release(release);
  await port.discardCandidates(release.token);
};

// Runs one transaction of the claim's run, again after a deadlock or a
// serialization failure (conflict-retry.ts). An attempt after a retry adds
// it to the claim first; that statement locks the singleton as the read
// FOR UPDATE would, so the lock order holds, and matches nothing once the
// claim is lost. The claim's total ends in the status with its completion
// (lastRun) or its release (lastError).
const claimTransaction = <T>(
  context: ActionContext,
  token: string,
  work: (port: CoordinationPort) => Promise<T>,
): Promise<T> =>
  retryingConflicts((retries) =>
    context.store.transaction(async (port) => {
      if (retries > 0) {
        await port.addRetries(token, context.owner, retries);
      }
      return work(port);
    }),
  );

// Runs one action transaction of the claim `token`. A run overtaken by a
// source or graph change is released in a second, committed transaction
// before the refusal is thrown: a throw inside the first one would roll
// the release back.
export const guarded = async <T>(
  context: ActionContext,
  token: string,
  work: (port: CoordinationPort) => Promise<Outcome<T>>,
): Promise<T> => {
  const outcome = await claimTransaction(context, token, work);
  if (outcome.kind === 'done') {
    return outcome.value;
  }
  const code =
    outcome.reason === 'source_changed'
      ? 'SOURCE_CHANGED'
      : 'FINGERPRINT_CHANGED';
  const { files } = outcome;
  const message = overtakenMessage(outcome.reason, files !== undefined);
  await claimTransaction(context, token, (port) =>
    releaseClaim(
      port,
      files === undefined
        ? { code, failed: false, message, token }
        : { code, failed: false, files, message, token },
    ),
  );
  throw coordinationError(code, message);
};

// Releases an abandoned claim before anything else happens, with the code
// abandonmentCode picks: a calculation interrupted for the first time at
// its inputs is left pending for the next claim, anything else waits for
// an explicit retry. Returns the state after the release, or the state as
// read when nothing was stale.
export const recoverInside = async (
  port: CoordinationPort,
  context: ActionContext,
): Promise<{ readonly released: boolean; readonly state: OperationsState }> => {
  const state = await port.readState(true);
  const stale = abandonedClaim(state, context.staleAfterMs);
  if (stale === null) {
    return { released: false, state };
  }
  const code = abandonmentCode(state, stale);
  await releaseClaim(port, {
    code,
    failed: true,
    message: abandonmentMessage(code, stale, context.staleAfterMs),
    token: stale.token,
  });
  return { released: true, state: await port.readState(true) };
};
