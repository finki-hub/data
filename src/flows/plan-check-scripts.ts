// The Run Script source of the page check of an enrollments page
// (pagePlanScript, shared.ts): the one coordination status row, the
// current enrollments claim at the page's revision, and the page's entry
// in the stored plan. The
// script defines `refuse` first (refuseFragment, text-fragments.ts), so
// each check refuses as `<place>: <fault>`; none names a claim token.

// Defines the one status row as `status`, and `claimFault(claim)`: why the
// status row's claim is not the current enrollments claim `claim`, or null.
export const statusRowScript = `
  const found = data.read_plan;
  if (!Array.isArray(found) || found.length !== 1 || found[0] === null || typeof found[0] !== 'object') {
    refuse('read_plan', 'expected 1 status row');
  }
  const status = found[0];
  const claimFault = function (claim) {
    if (status.claim_token !== claim) {
      return 'claim is not the current claim';
    }
    if (status.claim_domain !== 'enrollments') {
      return 'claim domain ' + (status.claim_domain === null || status.claim_domain === undefined ? 'none' : String(status.claim_domain)) + ', expected enrollments';
    }
    return null;
  };`;

// After statusRowScript, for the trigger payload `page`: refuses a page
// of another claim, domain or revision, or one the plan does not hold
// once. Defines `place` ("Page <token>"), `pages` (every planned page)
// and `planned` (the page's one entry).
export const plannedPageScript = `
  const place = 'Page ' + page.token;
  const claimed = claimFault(page.claim);
  if (claimed !== null) {
    refuse(place, claimed);
  }
  if (status.claim_revision !== page.revision) {
    refuse(place, 'revision ' + page.revision + ', expected ' + String(status.claim_revision));
  }
  const pages = Array.isArray(status.claim_pages) ? status.claim_pages : [];
  const entries = pages.filter(function (entry) {
    return entry !== null && typeof entry === 'object' && entry.token === page.token;
  });
  if (entries.length !== 1) {
    refuse(place, 'not planned under this claim');
  }
  const planned = entries[0];`;
