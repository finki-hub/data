import type { CoordinatorInput } from './options.js';

import { listText } from '../text.js';
import {
  type ActionContext,
  done,
  guarded,
  mismatch,
  overtaken,
  releaseClaim,
} from './action-support.js';
import {
  type CompletionDecision,
  currentFor,
  decideCompletion,
  dirtyAfterCompletion,
  verifyOwnership,
} from './decisions.js';
import { coordinationError } from './errors.js';

type Input<Action extends CoordinatorInput['action']> = Extract<
  CoordinatorInput,
  { action: Action }
>;

// The two actions that end a claim: complete installs its output (every
// staged page of a calculation) under the guards of the claim; fail releases it with its code and message.
// Both read the singleton FOR UPDATE first, like every token-bearing
// action (run-actions.ts).

// A calculation that never planned, or did not stage every planned page,
// installs nothing.
const pagesMissing = (
  decision: Extract<
    CompletionDecision,
    { readonly kind: 'pages_missing' | 'unplanned' }
  >,
) =>
  decision.kind === 'unplanned'
    ? coordinationError('PAGES_MISSING', 'Pages not planned', {
        details: { missing: null },
      })
    : coordinationError(
        'PAGES_MISSING',
        `Pages not staged: ${listText(decision.missing)}`,
        { details: { missing: decision.missing } },
      );

// The answer and the status (lastRun) carry how often the transactions of
// the run ran again after a database conflict (guarded, action-support.ts).
export const completeAction = (
  input: Input<'complete'>,
  context: ActionContext,
) =>
  guarded(context, input.token, async (port) => {
    const state = await port.readState(true);
    const fingerprint = currentFor(
      await port.currentFingerprints(),
      state.claim?.domain ?? null,
    );
    const decision = decideCompletion(state, {
      currentFingerprint: fingerprint,
      owner: context.owner,
      token: input.token,
    });
    if (
      decision.kind === 'claim_mismatch' ||
      decision.kind === 'owner_mismatch' ||
      state.claim === null
    ) {
      throw mismatch(
        decision.kind === 'owner_mismatch' ? decision.kind : 'claim_mismatch',
      );
    }
    const { claim } = state;
    if (
      decision.kind === 'source_changed' ||
      decision.kind === 'fingerprint_changed'
    ) {
      return overtaken(decision.kind);
    }
    if (decision.kind === 'unplanned' || decision.kind === 'pages_missing') {
      throw pagesMissing(decision);
    }
    const { counted, installed } =
      claim.domain === 'enrollments'
        ? await port.installEnrollments(input.token, claim.revision)
        : { counted: 0, installed: 0 };
    await port.discardCandidates(input.token);
    const finished = await port.finish({
      claimRevision: claim.revision,
      dirtyDomains: dirtyAfterCompletion(state, claim.domain),
      fingerprint,
      owner: context.owner,
      token: input.token,
    });
    if (!finished) {
      // Unreachable while the singleton is locked; kept as the last guard
      // of the install rather than trusted.
      throw coordinationError(
        'COMPLETION_RACED',
        'Claim changed during install',
      );
    }
    return done({
      completed: true,
      domain: claim.domain,
      installed,
      ...(claim.domain === 'enrollments' && { counted }),
      retries: claim.retries,
      revision: claim.revision,
    });
  });

// A failure releases the claim with its code and message.
export const failAction = (input: Input<'fail'>, context: ActionContext) =>
  context.store.transaction(async (port) => {
    const state = await port.readState(true);
    const verdict = verifyOwnership(state, {
      owner: context.owner,
      token: input.token,
    });
    if (verdict === 'claim_mismatch' || state.claim === null) {
      return { failed: false, reason: 'claim_mismatch' };
    }
    if (verdict === 'owner_mismatch') {
      throw mismatch(verdict);
    }
    const { claim } = state;
    await releaseClaim(port, {
      code: input.code,
      failed: true,
      message: input.message,
      token: input.token,
    });
    return {
      code: input.code,
      domain: claim.domain,
      failed: true,
      revision: claim.revision,
    };
  });
