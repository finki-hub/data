// Flow pieces the claim-bound page Flows share: a declared value as a Run
// Script literal, the failure record of a page step, and the check of a
// page against the claim's stored plan. The install-once helpers
// themselves live in flow-template.ts and install-flows.ts and are reused,
// not copied.
import { plannedPageScript, statusRowScript } from './plan-check-scripts.js';
import {
  countFragment,
  payloadRefusal,
  refuseFragment,
} from './text-fragments.js';

// A declared value as a string literal inside a Run Script body. Every
// value passed is lowercase words and underscores, so the literal needs no
// escaping.
export const scriptText = (value: string): string => `'${value}'`;

// A failure record in place of a result: where the run stopped, the code
// (the refused operation's own, or a fixed one for a script) and its
// message, plus the context the caller names (ids only, never a payload).
export const countFailure = (
  stage: string,
  context: Readonly<Record<string, string>>,
  code = '{{ $last.code }}',
): Readonly<Record<string, unknown>> => ({
  json: {
    ...context,
    code,
    message: '{{ $last.message }}',
    ok: false,
    stage,
  },
});

// The coordination status row, read the way the coordinator reads it (the
// first row by id): the current claim, its domain and revision, and the
// pages plan_pages stored for it.
export const planQuery = {
  fields: ['claim_token', 'claim_domain', 'claim_revision', 'claim_pages'],
  limit: 1,
  sort: ['id'],
} as const;

// Checks the page payload ($trigger = {claim, token, from, to, rows,
// revision}) against the plan the coordinator stored (read_plan): the claim
// must be the current enrollments claim at that very revision, and the page
// must be planned under it with exactly this range and row count. Answers
// the page as planned, and only that range is read. stage_page checks no
// more than that the token is planned, so a consistent payload of a
// sub-range, another page's range under this token or a claim of another
// domain would otherwise be staged as the whole page.
export const pagePlanScript = String.raw`module.exports = function (data) {
  ${refuseFragment}
  ${countFragment}
  const page = data.$trigger;
  const whole = function (value, least) { return Number.isSafeInteger(value) && value >= least; };
  if (page === null || typeof page !== 'object' || typeof page.claim !== 'string' || page.claim.length === 0 || typeof page.token !== 'string' || !/^p\d{4,9}$/u.test(page.token)) {
    ${payloadRefusal(['claim', 'token', 'from', 'to', 'rows', 'revision'])}
  }
  if (!whole(page.from, 1) || !whole(page.to, page.from) || !whole(page.rows, 0) || !whole(page.revision, 0)) {
    refuse('Invalid trigger payload', 'page ' + page.token + ': from, to, rows, revision must be integers');
  }${statusRowScript}${plannedPageScript}
  if (planned.from !== page.from || planned.to !== page.to || planned.rows !== page.rows) {
    refuse(place, 'range ' + page.from + '-' + page.to + ' (' + counted(page.rows, 'row', 'rows') + '), planned ' + String(planned.from) + '-' + String(planned.to) + ' (' + counted(planned.rows, 'row', 'rows') + ')');
  }
  return { claim: page.claim, from: planned.from, revision: page.revision, rows: planned.rows, to: planned.to, token: page.token };
};`;
