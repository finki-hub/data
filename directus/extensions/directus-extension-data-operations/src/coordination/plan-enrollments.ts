import type { CoordinationPort } from './port.js';

import { planEnrollmentPages } from '../enrollment-pages.js';
import {
  type ActionContext,
  done,
  guarded,
  mismatch,
  overtaken,
} from './action-support.js';
import { verifyClaim } from './decisions.js';
import { type ClaimDomain } from './domains.js';
import { coordinationError } from './errors.js';
import { type PageSource, pageSourceDomains } from './state.js';

// A table source is planned only under its own claim domain, and `rules`
// only while every rule is mapped_entries: the completion of an
// enrollments claim replaces every installed count, so a plan without the
// legacy family (user ranges, or rule ranges the legacy rules sit in)
// could otherwise drop that family's rows. The refusal names ids only.
export const checkPlanSource = async (
  port: CoordinationPort,
  domain: ClaimDomain | null,
  source: PageSource,
): Promise<void> => {
  const wanted = pageSourceDomains[source];
  if (domain !== wanted) {
    const hint =
      domain === 'enrollments' ? ', which plans with source enrollments' : '';
    throw coordinationError(
      'DOMAIN_MISMATCH',
      `plan_pages with source ${source} serves ${wanted} claims only; the current claim runs ${domain ?? 'no domain'}${hint}.`,
      { details: { domain, source } },
    );
  }
  if (source === 'rules') {
    const rules = await port.ruleModes();
    const other = rules.find(({ mode }) => mode !== 'mapped_entries');
    if (other !== undefined) {
      throw coordinationError(
        'DOMAIN_MISMATCH',
        `plan_pages with source rules plans mapped_entries rules only, and rule ${other.id} has another mode; plan with source enrollments, which covers the legacy family too. Nothing was planned.`,
        { details: { rule: other.id, source } },
      );
    }
  }
};

// plan_pages with source `enrollments`: the one plan of an enrollments
// claim. Both rule families are planned together (the completion replaces
// every installed count, so a family whose pages were not planned would
// lose its rows), every page is tracked for PAGES_MISSING, and the plan
// replaces an earlier plan of the claim with its candidates, like any
// other plan. The planner reads rule modes and history byte sizes only; a
// history over the page budget or a rule of an unknown mode refuses the
// whole plan, and the transaction leaves the claim as it was.
export const planEnrollmentsAction = (token: string, context: ActionContext) =>
  guarded(context, async (port) => {
    const state = await port.readState(true);
    const verdict = verifyClaim(state, { owner: context.owner, token });
    if (verdict === 'source_changed') {
      return overtaken(verdict, token);
    }
    if (verdict !== 'ok' || state.claim === null) {
      throw mismatch(verdict === 'ok' ? 'claim_mismatch' : verdict);
    }
    if (state.claim.domain !== 'enrollments') {
      throw coordinationError(
        'DOMAIN_MISMATCH',
        `plan_pages with source enrollments needs an enrollments claim; the current claim runs ${state.claim.domain ?? 'no domain'}.`,
      );
    }
    const pages = planEnrollmentPages(await port.enrollmentSources());
    const discarded = await port.discardCandidates(token);
    if (!(await port.storePlan(token, context.owner, pages))) {
      throw mismatch('claim_mismatch');
    }
    return done({
      discarded,
      pages,
      source: 'enrollments',
      total: pages.length,
    });
  });
