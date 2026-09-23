import type { CoordinationPort, CoordinationStore } from './port.js';
import type { OperationsState } from './state.js';

import { abandonedClaim } from './decisions.js';
import { type CoordinationError, coordinationError } from './errors.js';
import { abandonmentCode, interruptedCode } from './failures.js';

export type ActionContext = {
  readonly owner: string;
  readonly staleAfterMs: number;
  readonly store: CoordinationStore;
};

// Why an abandoned claim was released: the status carries it, since no
// caller is left to receive a refusal.
export const abandonedMessage =
  'The claim stopped heartbeating for longer than the stale window (a Directus restart or a Flow that ended without fail); its output was discarded. Mark the domain pending (or retry) to run it again.';

export const interruptedMessage =
  'The claim stopped heartbeating for longer than the stale window (a Directus restart or a Flow that ended without fail); its output was discarded and the domain runs once more on its own. A second interruption at the same inputs waits for Mark pending.';

const overtakenMessages: Readonly<Record<Overtaking, string>> = {
  fingerprint_changed:
    'The managed Flow graph changed during the run; its output was discarded and the domain stays pending.',
  source_changed:
    'A source change committed during the run; its output was discarded and the domain stays pending.',
};

export type Mismatch = 'claim_mismatch' | 'owner_mismatch';

export type Outcome<T> =
  Overtaken | { readonly kind: 'done'; readonly value: T };

export type Overtaken = {
  readonly kind: 'overtaken';
  readonly reason: Overtaking;
  readonly token: string;
};

export type Overtaking = 'fingerprint_changed' | 'source_changed';

export const done = <T>(value: T): Outcome<T> => ({ kind: 'done', value });

export const overtaken = (reason: Overtaking, token: string): Overtaken => ({
  kind: 'overtaken',
  reason,
  token,
});

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
  const message = overtakenMessages[outcome.reason];
  await context.store.transaction((port) =>
    releaseClaim(port, { code, failed: false, message, token: outcome.token }),
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
    message: code === interruptedCode ? interruptedMessage : abandonedMessage,
    token: stale.token,
  });
  return { released: true, state: await port.readState(true) };
};
