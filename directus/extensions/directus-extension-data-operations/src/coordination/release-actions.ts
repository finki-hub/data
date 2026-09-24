import type { CoordinatorInput } from './options.js';

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
import { normaliseDomains } from './domains.js';
import { coordinationError } from './errors.js';
import {
  checkReportedFiles,
  declaredFilenames,
  releasedPublicationState,
  requireEveryFileUploaded,
  withRevision,
} from './outcomes.js';

type Input<Action extends CoordinatorInput['action']> = Extract<
  CoordinatorInput,
  { action: Action }
>;

// The two actions that end a claim: complete installs its output (every
// staged page of a calculation, the outcome map of a publication) under
// the guards of the claim; fail releases it with its code and message.
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
    ? coordinationError(
        'PAGES_MISSING',
        'A history index or enrollment run must plan its pages (plan_pages) before it can complete.',
        { details: { missing: null } },
      )
    : coordinationError(
        'PAGES_MISSING',
        `Pages not staged yet: ${decision.missing.join(', ')}.`,
        { details: { missing: decision.missing } },
      );

// A publication completes with the outcome of every declared file, each
// uploaded; its outcomes are recorded whole, keyed by filename, and the
// claimed (prepared) revision is recorded as published. One superseded by
// a source change is recorded all the same, with publication kept pending
// for the newer revision (decideCompletion); one overtaken by a graph
// change keeps the outcomes of what it uploaded with its release, since an
// upload cannot be discarded.
export const completeAction = (
  input: Input<'complete'>,
  context: ActionContext,
) =>
  guarded(context, async (port) => {
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
    const declared = context.publishedFiles ?? declaredFilenames;
    checkReportedFiles(input.files, claim.domain, declared);
    const files =
      input.files === undefined
        ? undefined
        : withRevision(input.files, claim.revision);
    if (
      decision.kind === 'source_changed' ||
      decision.kind === 'fingerprint_changed'
    ) {
      return overtaken(decision.kind, input.token, files);
    }
    if (decision.kind === 'unplanned' || decision.kind === 'pages_missing') {
      throw pagesMissing(decision);
    }
    if (claim.domain === 'publication') {
      requireEveryFileUploaded(input.files, declared);
    }
    const superseded = decision.kind === 'superseded';
    const installed =
      claim.domain === 'enrollments'
        ? await port.installEnrollments(input.token, claim.revision)
        : 0;
    await port.discardCandidates(input.token);
    const finished = await port.finish({
      claimRevision: claim.revision,
      dirtyDomains: superseded
        ? normaliseDomains([...state.dirtyDomains, 'publication'])
        : dirtyAfterCompletion(state, claim.domain),
      files: files ?? null,
      fingerprint,
      owner: context.owner,
      superseded,
      token: input.token,
    });
    if (!finished) {
      // Unreachable while the singleton is locked; kept as the last guard
      // of the install rather than trusted.
      throw coordinationError(
        'COMPLETION_RACED',
        'The claim changed while its output was being installed; nothing was installed.',
      );
    }
    return done({
      completed: true,
      domain: claim.domain,
      installed,
      revision: claim.revision,
      // The newer source revision a publication left pending, if any.
      ...(claim.domain === 'publication' && {
        pendingRevision: superseded ? state.sourceRevision : null,
      }),
    });
  });

// A failure releases the claim with its code and message. A publication
// may report the outcome of each file it attempted: they are recorded
// (without a map, the outcomes its loop recorded file by file stay), and
// its state becomes partial when some file was uploaded at the claimed
// revision, failed when none was; the revision is never recorded as
// published.
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
    checkReportedFiles(
      input.files,
      claim.domain,
      context.publishedFiles ?? declaredFilenames,
    );
    const files =
      input.files === undefined
        ? undefined
        : withRevision(input.files, claim.revision);
    await releaseClaim(port, {
      code: input.code,
      failed: true,
      message: input.message,
      token: input.token,
      ...(files !== undefined && { files }),
    });
    return {
      code: input.code,
      domain: claim.domain,
      failed: true,
      revision: claim.revision,
      ...(claim.domain === 'publication' && {
        publication: releasedPublicationState(
          true,
          files ?? state.publicationOutcomes,
          claim.revision,
        ),
      }),
    };
  });
