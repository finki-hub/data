import type { CoordinatorInput } from './options.js';
import type { PageSource } from './state.js';

import { duplicatePairs, planPages } from '../page-state.js';
import {
  type ActionContext,
  done,
  guarded,
  mismatch,
  overtaken,
  releaseClaim,
} from './action-support.js';
import {
  decideCompletion,
  decideStage,
  dirtyAfterCompletion,
  verifyClaim,
  verifyOwnership,
} from './decisions.js';
import { coordinationError } from './errors.js';
import { checkPlanSource } from './plan-enrollments.js';

type Input<Action extends CoordinatorInput['action']> = Extract<
  CoordinatorInput,
  { action: Action }
>;

// Every token-bearing action reads the singleton FOR UPDATE first: the
// decision it takes still holds when its guarded write runs, a source
// statement committing meanwhile waits on that row inside its own trigger,
// and the lock order (singleton, then candidate rows) is the one the claim
// and its recovery use, so no cycle is possible.

// A plan starts, or restarts, the staging of the claim: every candidate row
// staged under the claim so far is discarded in the same transaction, so a
// completed run installs exactly the pages of its current plan and never a
// page of a plan it replaced. A source that does not fit the claim's domain
// is refused first (checkPlanSource), and the claim stays as it was.
export const planPagesAction = (
  input: { readonly source: PageSource; readonly token: string },
  context: ActionContext,
) =>
  guarded(context, async (port) => {
    const state = await port.readState(true);
    const verdict = verifyClaim(state, {
      owner: context.owner,
      token: input.token,
    });
    if (verdict === 'source_changed') {
      return overtaken(verdict, input.token);
    }
    if (verdict !== 'ok' || state.claim === null) {
      throw mismatch(verdict === 'ok' ? 'claim_mismatch' : verdict);
    }
    await checkPlanSource(port, state.claim.domain, input.source);
    const discarded = await port.discardCandidates(input.token);
    const pages = planPages(await port.sourceIds(input.source));
    if (!(await port.storePlan(input.token, context.owner, pages))) {
      throw mismatch('claim_mismatch');
    }
    return done({
      discarded,
      pages,
      source: input.source,
      total: pages.length,
    });
  });

export const stagePageAction = (
  input: Input<'stage_page'>,
  context: ActionContext,
) =>
  guarded(context, async (port) => {
    const duplicates = duplicatePairs(input.rows);
    if (duplicates.length > 0) {
      throw coordinationError(
        'DUPLICATE_ROWS',
        `A page must carry each course/year pair once; duplicated: ${duplicates.join(', ')}.`,
        { status: 400 },
      );
    }
    const state = await port.readState(true);
    const decision = decideStage(state, {
      owner: context.owner,
      page: input.page,
      token: input.token,
    });
    if (decision.kind === 'source_changed') {
      return overtaken(decision.kind, input.token);
    }
    if (decision.kind === 'page_unplanned') {
      throw coordinationError(
        'PAGE_UNPLANNED',
        `Page ${input.page} is not part of the plan of this claim; call plan_pages first.`,
      );
    }
    if (decision.kind !== 'ok' || state.claim === null) {
      throw mismatch(decision.kind === 'ok' ? 'claim_mismatch' : decision.kind);
    }
    const replaced = await port.discardCandidates(input.token, input.page);
    const staged =
      input.rows.length === 0
        ? 0
        : await port.insertCandidates({
            page: input.page,
            revision: state.claim.revision,
            rows: input.rows,
            token: input.token,
          });
    if (
      !(await port.recordStagedPage(input.token, context.owner, input.page))
    ) {
      throw mismatch('claim_mismatch');
    }
    return done({ page: input.page, replaced, staged });
  });

export const completeAction = (
  input: Input<'complete'>,
  context: ActionContext,
) =>
  guarded(context, async (port) => {
    const state = await port.readState(true);
    const fingerprint = await port.currentFingerprint();
    const decision = decideCompletion(state, {
      currentFingerprint: fingerprint,
      owner: context.owner,
      token: input.token,
    });
    if (
      decision.kind === 'source_changed' ||
      decision.kind === 'fingerprint_changed'
    ) {
      return overtaken(decision.kind, input.token);
    }
    if (decision.kind === 'unplanned' || decision.kind === 'pages_missing') {
      throw coordinationError(
        'PAGES_MISSING',
        decision.kind === 'unplanned'
          ? 'A history index or enrollment run must plan its pages (plan_pages) before it can complete.'
          : `Pages not staged yet: ${decision.missing.join(', ')}.`,
        {
          details: {
            missing:
              decision.kind === 'pages_missing' ? decision.missing : null,
          },
        },
      );
    }
    if (decision.kind !== 'ok' || state.claim === null) {
      throw mismatch(decision.kind === 'ok' ? 'claim_mismatch' : decision.kind);
    }
    const { claim } = state;
    const installed =
      claim.domain === 'enrollments'
        ? await port.installEnrollments(input.token, claim.revision)
        : 0;
    await port.discardCandidates(input.token);
    const finished = await port.finish({
      claimRevision: claim.revision,
      dirtyDomains: dirtyAfterCompletion(state, claim.domain),
      files: input.files ?? null,
      fingerprint,
      owner: context.owner,
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
    });
  });

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
    await releaseClaim(port, {
      code: input.code,
      failed: true,
      message: input.message,
      token: input.token,
    });
    return {
      code: input.code,
      domain: state.claim.domain,
      failed: true,
      revision: state.claim.revision,
    };
  });

export const heartbeatAction = (token: string, context: ActionContext) =>
  context.store.transaction(async (port) => {
    const state = await port.readState(true);
    const verdict = verifyOwnership(state, { owner: context.owner, token });
    if (verdict !== 'ok') {
      throw mismatch(verdict);
    }
    if (!(await port.heartbeat(token, context.owner))) {
      throw mismatch('claim_mismatch');
    }
    return { heartbeat: true };
  });
