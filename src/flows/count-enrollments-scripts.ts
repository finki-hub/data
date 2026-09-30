import { mappedPageKind, scriptText } from './shared.js';
import {
  payloadRefusal,
  refuseFragment,
  relayFragment,
} from './text-fragments.js';

// The Run Script bodies of "Data / Count enrollments" and of the mapped
// family's runner "Data / Count mapped enrollment pages". Each runs inside
// the isolated Directus script sandbox (no imports, no services, the whole
// data chain as `data`), returns structured-clone-able values only, and
// names families, pages and ids, never a history, a pattern or a name. The
// unit suite runs them in node:vm. The dispatcher's scripts name no rule
// mode: a family is whatever plan_pages planned.

// The families of the enrollments plan (plan_pages source enrollments),
// each with the claim, its revision and the runner Flow the planner named:
// the payload "Data / Run enrollment family" hands to that runner.
export const familiesScript = `module.exports = function (data) {
  ${refuseFragment}
  const trigger = data.$trigger;
  if (trigger === null || typeof trigger !== 'object' || typeof trigger.claim !== 'string' || trigger.claim.length === 0 || !Number.isSafeInteger(trigger.revision) || trigger.revision < 0) {
    ${payloadRefusal(['claim', 'revision'])}
  }
  const plan = data.plan;
  if (plan === null || typeof plan !== 'object' || !Array.isArray(plan.families)) {
    refuse('plan_pages', 'no family list');
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  return plan.families.map(function (family, index) {
    if (family === null || typeof family !== 'object' || typeof family.kind !== 'string' || typeof family.runnerFlowId !== 'string' || !uuid.test(family.runnerFlowId) || !Array.isArray(family.pages)) {
      refuse('Plan family ' + (index + 1), 'kind, runnerFlowId or pages missing');
    }
    return { claim: trigger.claim, kind: family.kind, pages: family.pages, revision: trigger.revision, runner: family.runnerFlowId };
  });
};`;

// Every family answered {kind, ok: true, summary} through its runner; the
// first family that did not becomes the refusal, relayed with its stage
// and code and cut to a bounded length. The completion checks the staged
// pages itself, so a family that answered without staging all of its
// pages is refused there (PAGES_MISSING).
export const familiesCheckScript = `module.exports = function (data) {
  ${refuseFragment}
  ${relayFragment}
  const families = Array.isArray(data.families) ? data.families : null;
  const results = data.run_families;
  if (families === null || !Array.isArray(results) || results.length !== families.length) {
    refuse('run_families', 'results ' + (Array.isArray(results) ? results.length : 'none') + ', expected ' + (families === null ? 'none' : families.length));
  }
  return {
    families: families.map(function (family, index) {
      const result = results[index];
      const place = 'Family ' + family.kind;
      if (result !== null && typeof result === 'object' && result.ok === false) {
        throw new Error(relayed(place, result));
      }
      if (result === null || typeof result !== 'object' || result.ok !== true || result.kind !== family.kind) {
        refuse(place, 'no valid answer');
      }
      return { kind: family.kind, pages: family.pages.length, summary: result.summary };
    }),
  };
};`;

// The pages of the mapped family, each with the claim and its revision:
// the payload the Task 11 page Flow checks against the stored plan. A
// family holding a page of another kind is refused before any page runs.
export const mappedPagesScript = `module.exports = function (data) {
  ${refuseFragment}
  const family = data.$trigger;
  if (family === null || typeof family !== 'object' || typeof family.claim !== 'string' || family.claim.length === 0 || !Number.isSafeInteger(family.revision) || family.revision < 0 || !Array.isArray(family.pages)) {
    ${payloadRefusal(['claim', 'revision', 'pages'])}
  }
  return family.pages.map(function (page, index) {
    if (page === null || typeof page !== 'object' || page.kind !== ${scriptText(mappedPageKind)}) {
      const kind = page !== null && typeof page === 'object' && typeof page.kind === 'string' ? page.kind : 'none';
      refuse('Family page ' + (index + 1), 'kind ' + kind + ', expected ${mappedPageKind}');
    }
    return { claim: family.claim, from: page.from, revision: family.revision, rows: page.rows, to: page.to, token: page.token };
  });
};`;

// Every mapped page answered its own stage_page summary with one staged
// row per planned rule (the page stages every pair, zeros included); the
// first failure record becomes the refusal, relayed with its stage and
// code and cut to a bounded length.
export const mappedCheckScript = `module.exports = function (data) {
  ${refuseFragment}
  ${relayFragment}
  const pages = Array.isArray(data.mapped_pages) ? data.mapped_pages : null;
  const results = data.count_pages;
  if (pages === null || !Array.isArray(results) || results.length !== pages.length) {
    refuse('count_pages', 'results ' + (Array.isArray(results) ? results.length : 'none') + ', expected ' + (pages === null ? 'none' : pages.length));
  }
  let staged = 0;
  for (const [index, page] of pages.entries()) {
    const result = results[index];
    const place = 'Mapped page ' + page.token;
    if (result !== null && typeof result === 'object' && result.ok === false) {
      throw new Error(relayed(place, result));
    }
    if (result === null || typeof result !== 'object' || result.page !== page.token || !Number.isSafeInteger(result.staged) || result.staged !== page.rows) {
      refuse(place, 'invalid summary');
    }
    staged += result.staged;
  }
  return { pages: pages.length, staged: staged };
};`;
