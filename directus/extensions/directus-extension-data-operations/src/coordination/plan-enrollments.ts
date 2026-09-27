import type { CoordinationPort } from './port.js';

import { planEnrollmentFamilies } from '../enrollment-pages.js';
import { rulesPlanMode } from '../rule-modes.js';
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
// only while every rule has the one mode its page Flow counts
// (rulesPlanMode, rule-modes.ts): the completion of an enrollments claim
// replaces every installed count, so a plan without another family (its
// rule pages, or the history pages they cross) could otherwise drop that
// family's rows, and that page Flow refuses a page holding a rule of
// another mode. The refusal names ids only.
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
    const other = rules.find(({ mode }) => mode !== rulesPlanMode.mode);
    if (other !== undefined) {
      throw coordinationError(
        'DOMAIN_MISMATCH',
        `plan_pages with source rules plans ${rulesPlanMode.mode} rules only, and rule ${other.id} has another mode; plan with source enrollments, which covers every rule mode. Nothing was planned.`,
        { details: { rule: other.id, source } },
      );
    }
  }
};

// plan_pages with source `enrollments`: the one plan of an enrollments
// claim, one family per declared rule mode that has rules (the completion
// replaces every installed count, so a family whose pages were not planned
// would lose its rows). The answer names each family's runner Flow and
// pages; the stored plan keeps every page, so the completion refuses
// (PAGES_MISSING) until every family's pages are staged, and the plan
// replaces an earlier plan of the claim with its candidates, like any
// other plan. The planner reads rule modes and history byte sizes only; a
// history over the page budget or a rule of an undeclared mode refuses the
// whole plan, and the transaction leaves the claim as it was.
export const planEnrollmentsAction = (token: string, context: ActionContext) =>
  guarded(context, token, async (port) => {
    const state = await port.readState(true);
    const verdict = verifyClaim(state, { owner: context.owner, token });
    if (verdict === 'source_changed') {
      return overtaken(verdict);
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
    const families = planEnrollmentFamilies(await port.enrollmentSources());
    const pages = families.flatMap((family) => family.pages);
    const discarded = await port.discardCandidates(token);
    if (!(await port.storePlan(token, context.owner, pages))) {
      throw mismatch('claim_mismatch');
    }
    return done({
      discarded,
      families,
      source: 'enrollments',
      total: pages.length,
    });
  });
