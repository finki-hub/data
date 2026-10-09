import type { CoordinatorInput } from './options.js';

import { duplicateMatches, planPages } from '../page-state.js';
import { listText } from '../text.js';
import {
  type ActionContext,
  done,
  guarded,
  mismatch,
  overtaken,
} from './action-support.js';
import { decideStage, verifyClaim, verifyOwnership } from './decisions.js';
import { coordinationError } from './errors.js';
import {
  boundedCode,
  checkReportedFiles,
  declaredFilenames,
  mergedOutcomes,
} from './outcomes.js';
import { domainMismatch, pageUnplanned } from './refusals.js';
import {
  type PageSource,
  pageSourceDomains,
  publicationUploadLeaseMs,
} from './state.js';

type Input<Action extends CoordinatorInput['action']> = Extract<
  CoordinatorInput,
  { action: Action }
>;

// Every token-bearing action reads the singleton FOR UPDATE first (an
// attempt after a database conflict first adds its retry to that row,
// under the same lock): the decision it takes still holds when its guarded
// write runs, a source statement committing meanwhile waits on that row
// inside its own trigger, and the lock order (singleton, then candidate
// rows) is the one the claim and its recovery use, so no cycle is
// possible.

// A table source is planned only under its own claim domain: history under
// a history index claim, entries under an enrollments claim. The refusal
// names the domains only.
const checkPlanSource = (domain: null | string, source: PageSource): void => {
  const expected = pageSourceDomains[source];
  if (domain !== expected) {
    throw domainMismatch(
      { actual: domain, expected, subject: `plan_pages source ${source}` },
      { details: { domain, source } },
    );
  }
};

// A plan starts, or restarts, the staging of the claim: every candidate row
// staged under the claim so far is discarded in the same transaction, so a
// completed run installs exactly the pages of its current plan and never a
// page of a plan it replaced. A source that does not fit the claim's domain
// is refused first (checkPlanSource), and the claim stays as it was.
export const planPagesAction = (
  input: { readonly source: PageSource; readonly token: string },
  context: ActionContext,
) =>
  guarded(context, input.token, async (port) => {
    const state = await port.readState(true);
    const verdict = verifyClaim(state, {
      owner: context.owner,
      token: input.token,
    });
    if (verdict === 'source_changed') {
      return overtaken(verdict);
    }
    if (verdict !== 'ok' || state.claim === null) {
      throw mismatch(verdict === 'ok' ? 'claim_mismatch' : verdict);
    }
    checkPlanSource(state.claim.domain, input.source);
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
  guarded(context, input.token, async (port) => {
    const duplicates = duplicateMatches(input.rows);
    if (duplicates.length > 0) {
      throw coordinationError(
        'DUPLICATE_ROWS',
        `Duplicate matches: ${listText(duplicates)}`,
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
      return overtaken(decision.kind);
    }
    if (decision.kind === 'page_unplanned') {
      throw pageUnplanned(input.page);
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

// A heartbeat of a publication claim comes right before an upload and
// leases the claim until that upload can no longer write (state.ts).
export const heartbeatAction = (token: string, context: ActionContext) =>
  context.store.transaction(async (port) => {
    const state = await port.readState(true);
    const verdict = verifyOwnership(state, { owner: context.owner, token });
    if (verdict !== 'ok') {
      throw mismatch(verdict);
    }
    const leaseMs =
      state.claim?.domain === 'publication' ? publicationUploadLeaseMs : 0;
    if (!(await port.heartbeat(token, context.owner, leaseMs))) {
      throw mismatch('claim_mismatch');
    }
    return { heartbeat: true };
  });

// The outcome of one published file, recorded as soon as the publish loop
// knows it, at the claimed revision, so a run that stops before its final
// complete or fail (a restart, a refused step) still shows every file it
// uploaded. A source change does not refuse it: an upload cannot be taken
// back. It refreshes the heartbeat, which ends the upload lease.
export const recordAction = (input: Input<'record'>, context: ActionContext) =>
  context.store.transaction(async (port) => {
    const state = await port.readState(true);
    const verdict = verifyOwnership(state, {
      owner: context.owner,
      token: input.token,
    });
    if (verdict !== 'ok' || state.claim === null) {
      throw mismatch(verdict === 'ok' ? 'claim_mismatch' : verdict);
    }
    const { revision } = state.claim;
    const code = input.outcome === 'uploaded' ? null : boundedCode(input.code);
    const entry = { bytes: input.bytes ?? null, code, outcome: input.outcome };
    const declared = context.publishedFiles ?? declaredFilenames;
    checkReportedFiles(
      { [input.filename]: entry },
      state.claim.domain,
      declared,
    );
    const files = mergedOutcomes(
      state.publicationOutcomes,
      { [input.filename]: { ...entry, revision } },
      declared,
    );
    if (!(await port.recordOutcomes(input.token, context.owner, files))) {
      throw mismatch('claim_mismatch');
    }
    return { filename: input.filename, outcome: input.outcome, revision };
  });
