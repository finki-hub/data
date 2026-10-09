import {
  payloadRefusal,
  refuseFragment,
  relayFragment,
} from './text-fragments.js';

// The Run Script bodies of "Data / Count enrollments". Each runs inside the
// isolated Directus script sandbox (no imports, no services, the whole data
// chain as `data`), returns structured-clone-able values only, and names
// pages and ids, never a history line, a pattern or a name. The unit suite
// runs them in node:vm.

// The pages of the entries plan (plan_pages source entries), each with the
// claim and its revision: the payload "Data / Match history lines" checks
// against the stored plan.
export const pagesScript = `module.exports = function (data) {
  ${refuseFragment}
  const trigger = data.$trigger;
  if (trigger === null || typeof trigger !== 'object' || typeof trigger.claim !== 'string' || trigger.claim.length === 0 || !Number.isSafeInteger(trigger.revision) || trigger.revision < 0) {
    ${payloadRefusal(['claim', 'revision'])}
  }
  const plan = data.plan;
  if (plan === null || typeof plan !== 'object' || !Array.isArray(plan.pages)) {
    refuse('plan_pages', 'no page list');
  }
  return plan.pages.map(function (page, index) {
    if (page === null || typeof page !== 'object' || typeof page.token !== 'string') {
      refuse('Plan page ' + (index + 1), 'token missing');
    }
    return { claim: trigger.claim, from: page.from, revision: trigger.revision, rows: page.rows, to: page.to, token: page.token };
  });
};`;

// Every page answered {ok: true, page, staged}; the first failure record
// becomes the refusal, relayed with its stage and code and cut to a
// bounded length. The completion checks the staged pages itself, so a page
// that answered without staging is refused there (PAGES_MISSING).
export const pagesCheckScript = `module.exports = function (data) {
  ${refuseFragment}
  ${relayFragment}
  const pages = Array.isArray(data.pages) ? data.pages : null;
  const results = data.match_pages;
  if (pages === null || !Array.isArray(results) || results.length !== pages.length) {
    refuse('match_pages', 'results ' + (Array.isArray(results) ? results.length : 'none') + ', expected ' + (pages === null ? 'none' : pages.length));
  }
  let staged = 0;
  for (const [index, page] of pages.entries()) {
    const result = results[index];
    const place = 'Page ' + page.token;
    if (result !== null && typeof result === 'object' && result.ok === false) {
      throw new Error(relayed(place, result));
    }
    if (result === null || typeof result !== 'object' || result.ok !== true || result.page !== page.token || !Number.isSafeInteger(result.staged) || result.staged < 0) {
      refuse(place, 'invalid summary');
    }
    staged += result.staged;
  }
  return { pages: pages.length, staged: staged };
};`;
