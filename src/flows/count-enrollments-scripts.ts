// The Run Script bodies of "Data / Count enrollments". Each runs inside the
// isolated Directus script sandbox (no imports, no services, the whole data
// chain as `data`), returns structured-clone-able values only, and names
// pages and ids, never a history, a pattern or a name. The unit suite runs
// them in node:vm.

// The mapped pages of the enrollments plan (plan_pages source enrollments),
// each with the claim and its revision: the payload the Task 11 page Flow
// checks against the stored plan. Legacy and zero pages are left to
// "Data / Count legacy enrollments", which reads the same stored plan.
export const mappedPagesScript = `module.exports = function (data) {
  const trigger = data.$trigger;
  if (trigger === null || typeof trigger !== 'object' || typeof trigger.claim !== 'string' || trigger.claim.length === 0 || !Number.isSafeInteger(trigger.revision) || trigger.revision < 0) {
    throw new Error('The enrollment count needs {claim, revision} of an enrollments claim as its trigger payload.');
  }
  const plan = data.plan;
  if (plan === null || typeof plan !== 'object' || !Array.isArray(plan.pages)) {
    throw new Error('plan_pages returned no page list; nothing was counted.');
  }
  return plan.pages.filter(function (page) {
    return page !== null && typeof page === 'object' && page.kind === 'mapped';
  }).map(function (page) {
    return { claim: trigger.claim, from: page.from, revision: trigger.revision, rows: page.rows, to: page.to, token: page.token };
  });
};`;

// Every mapped page answered its own stage_page summary with one staged
// row per planned rule (the page stages every pair, zeros included); the
// first failure record becomes the refusal, cut to a bounded length.
export const mappedCheckScript = `module.exports = function (data) {
  const pages = Array.isArray(data.mapped_pages) ? data.mapped_pages : null;
  const results = data.count_mapped;
  if (pages === null || !Array.isArray(results) || results.length !== pages.length) {
    throw new Error('count_mapped answered ' + (Array.isArray(results) ? results.length : 'no') + ' results for ' + (pages === null ? 'no' : pages.length) + ' mapped pages; nothing was installed.');
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
