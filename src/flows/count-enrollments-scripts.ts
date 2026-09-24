import { mappedPageKind, scriptText } from './shared.js';

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
  const trigger = data.$trigger;
  if (trigger === null || typeof trigger !== 'object' || typeof trigger.claim !== 'string' || trigger.claim.length === 0 || !Number.isSafeInteger(trigger.revision) || trigger.revision < 0) {
    throw new Error('The enrollment count needs {claim, revision} of an enrollments claim as its trigger payload.');
  }
  const plan = data.plan;
  if (plan === null || typeof plan !== 'object' || !Array.isArray(plan.families)) {
    throw new Error('plan_pages returned no family list; nothing was counted.');
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  return plan.families.map(function (family, index) {
    if (family === null || typeof family !== 'object' || typeof family.kind !== 'string' || typeof family.runnerFlowId !== 'string' || !uuid.test(family.runnerFlowId) || !Array.isArray(family.pages)) {
      throw new Error('Family ' + (index + 1) + ' of the plan names no kind, runner Flow or page list; nothing was counted.');
    }
    return { claim: trigger.claim, kind: family.kind, pages: family.pages, revision: trigger.revision, runner: family.runnerFlowId };
  });
};`;

// Every family answered {kind, ok: true, summary} through its runner; the
// first family that did not becomes the refusal, cut to a bounded length.
// The completion checks the staged pages itself, so a family that answered
// without staging all of its pages is refused there (PAGES_MISSING).
export const familiesCheckScript = `module.exports = function (data) {
  const families = Array.isArray(data.families) ? data.families : null;
  const results = data.run_families;
  if (families === null || !Array.isArray(results) || results.length !== families.length) {
    throw new Error('run_families answered ' + (Array.isArray(results) ? results.length : 'no') + ' results for ' + (families === null ? 'no' : families.length) + ' families; nothing was installed.');
  }
  return {
    families: families.map(function (family, index) {
      const result = results[index];
      if (result === null || typeof result !== 'object' || result.ok !== true || result.kind !== family.kind) {
        const cause = result !== null && typeof result === 'object' && result.ok === false ? (String(result.stage) + ': ' + String(result.code) + ' ' + String(result.message)).slice(0, 400) : 'no valid answer';
        throw new Error('Enrollment family ' + family.kind + ' failed (' + cause + '); nothing was installed.');
      }
      return { kind: family.kind, pages: family.pages.length, summary: result.summary };
    }),
  };
};`;

// The pages of the mapped family, each with the claim and its revision:
// the payload the Task 11 page Flow checks against the stored plan. A
// family holding a page of another kind is refused before any page runs.
export const mappedPagesScript = `module.exports = function (data) {
  const family = data.$trigger;
  if (family === null || typeof family !== 'object' || typeof family.claim !== 'string' || family.claim.length === 0 || !Number.isSafeInteger(family.revision) || family.revision < 0 || !Array.isArray(family.pages)) {
    throw new Error('The mapped family needs {claim, revision, pages} of an enrollments plan as its trigger payload.');
  }
  return family.pages.map(function (page, index) {
    if (page === null || typeof page !== 'object' || page.kind !== ${scriptText(mappedPageKind)}) {
      throw new Error('Page ' + (index + 1) + ' of the mapped family is not a ${mappedPageKind} page; nothing was counted.');
    }
    return { claim: family.claim, from: page.from, revision: family.revision, rows: page.rows, to: page.to, token: page.token };
  });
};`;

// Every mapped page answered its own stage_page summary with one staged
// row per planned rule (the page stages every pair, zeros included); the
// first failure record becomes the refusal, cut to a bounded length.
export const mappedCheckScript = `module.exports = function (data) {
  const pages = Array.isArray(data.mapped_pages) ? data.mapped_pages : null;
  const results = data.count_pages;
  if (pages === null || !Array.isArray(results) || results.length !== pages.length) {
    throw new Error('count_pages answered ' + (Array.isArray(results) ? results.length : 'no') + ' results for ' + (pages === null ? 'no' : pages.length) + ' mapped pages; nothing was installed.');
  }
  let staged = 0;
  for (const [index, page] of pages.entries()) {
    const result = results[index];
    if (result !== null && typeof result === 'object' && result.ok === false) {
      const cause = (String(result.stage) + ': ' + String(result.code) + ' ' + String(result.message)).slice(0, 400);
      throw new Error('Mapped page ' + page.token + ' failed (' + cause + '); nothing was installed.');
    }
    if (result === null || typeof result !== 'object' || result.page !== page.token || !Number.isSafeInteger(result.staged) || result.staged !== page.rows) {
      throw new Error('Mapped page ' + page.token + ' answered no valid summary; nothing was installed.');
    }
    staged += result.staged;
  }
  return { pages: pages.length, staged: staged };
};`;
