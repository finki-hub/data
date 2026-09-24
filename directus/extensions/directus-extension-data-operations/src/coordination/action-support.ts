import type { StoredOutcomes } from './outcomes.js';
import type { CoordinationPort, CoordinationStore } from './port.js';
import type { Claim, OperationsState } from './state.js';

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

// Why an abandoned claim was released: the status carries it, since no
// caller is left to receive a refusal.
export const abandonedMessage =
  'The claim stopped heartbeating for longer than the stale window (a Directus restart or a Flow that ended without fail); its output was discarded. Mark the domain pending (or retry) to run it again.';

export const interruptedMessage =
  'The claim stopped heartbeating for longer than the stale window (a Directus restart or a Flow that ended without fail); its output was discarded and the domain runs once more on its own. A second interruption at the same inputs waits for Mark pending.';

// An upload cannot be discarded: the status keeps the outcome each file
// recorded, and says what it cannot know.
export const abandonedPublicationMessage =
  'The publication claim stopped heartbeating for longer than the stale window, after any upload lease (a Directus restart or a Flow that ended without fail). The files recorded uploaded at this revision hold it; an upload running at that moment may have finished without being recorded. The source revision is not recorded as published: publish again.';

const abandonmentMessage = (code: string, claim: Claim): string => {
  if (code === interruptedCode) {
    return interruptedMessage;
  }
  return claim.domain === 'publication'
    ? abandonedPublicationMessage
    : abandonedMessage;
};

const overtakenMessages: Readonly<Record<Overtaking, string>> = {
  fingerprint_changed:
    'The managed Flow graph changed during the run; its output was discarded and the domain stays pending.',
  source_changed:
    'A source change committed during the run; its output was discarded and the domain stays pending.',
};

// An upload cannot be discarded: an overtaken publication keeps the
// outcome of each file it uploaded, and the revision stays unpublished.
const overtakenPublicationMessages: Readonly<Record<Overtaking, string>> = {
  fingerprint_changed:
    'The publication Flow graph changed during the publication; the uploaded files are recorded, the source revision is not recorded as published and publication stays pending. Publish again.',
  source_changed:
    'A source change committed during the publication; the uploaded files hold the prepared source revision, which is not recorded as published, and publication stays pending. Publish again.',
};

export type Mismatch = 'claim_mismatch' | 'owner_mismatch';

export type Outcome<T> =
  Overtaken | { readonly kind: 'done'; readonly value: T };

export type Overtaken = {
  // The outcomes of an overtaken publication, kept with its release.
  readonly files?: StoredOutcomes;
  readonly kind: 'overtaken';
  readonly reason: Overtaking;
  readonly token: string;
};

export type Overtaking = 'fingerprint_changed' | 'source_changed';

export const done = <T>(value: T): Outcome<T> => ({ kind: 'done', value });

export const overtaken = (
  reason: Overtaking,
  token: string,
  files?: StoredOutcomes,
): Overtaken =>
  files === undefined
    ? { kind: 'overtaken', reason, token }
    : { files, kind: 'overtaken', reason, token };

export const unreachable = (value: never): never => {
  throw new TypeError(`Unexpected coordination case: ${String(value)}`);
};

export const mismatch = (verdict: Mismatch): CoordinationError =>
  verdict === 'claim_mismatch'
    ? coordinationError(
        'CLAIM_MISMATCH',
        'The token does not name the current claim.',
      )
    : coordinationError(
        'OWNER_MISMATCH',
        'The claim belongs to another Directus process.',
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

// Runs one action transaction. A run overtaken by a source or graph change
// is released in a second, committed transaction before the refusal is
// thrown: a throw inside the first one would roll the release back.
export const guarded = async <T>(
  context: ActionContext,
  work: (port: CoordinationPort) => Promise<Outcome<T>>,
): Promise<T> => {
  const outcome = await context.store.transaction(work);
  if (outcome.kind === 'done') {
    return outcome.value;
  }
  const code =
    outcome.reason === 'source_changed'
      ? 'SOURCE_CHANGED'
      : 'FINGERPRINT_CHANGED';
  const { files, token } = outcome;
  const message =
    files === undefined
      ? overtakenMessages[outcome.reason]
      : overtakenPublicationMessages[outcome.reason];
  await context.store.transaction((port) =>
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
    message: abandonmentMessage(code, stale),
    token: stale.token,
  });
  return { released: true, state: await port.readState(true) };
};
