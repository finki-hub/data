// The small Run Script bodies of the legacy enrollment Flows that check
// the stored plan and the answers of the child Flows. The two bodies that
// touch data, count-history-page.cjs and sum-counts.cjs, live in
// directus/flows. stage_page checks only that a page token is planned, so
// every page checks itself against the plan the coordinator stored for
// the claim (kind, ranges, bytes and revision) before it reads a row, and
// no refusal names a claim token, a history, a pattern or a name.

// The coordination status row, read the way the coordinator reads it: the
// current claim, its domain, revision, planned pages and staged pages.
export const legacyPlanQuery = {
  fields: [
    'claim_token',
    'claim_domain',
    'claim_revision',
    'claim_pages',
    'claim_staged',
  ],
  limit: 1,
  sort: ['id'],
} as const;

// Shared start of the page checks: the helpers, the one status row, and
// the current enrollments claim at the page's revision.
const pageStatus = `
  const whole = function (value, least) { return Number.isSafeInteger(value) && value >= least; };
  const isRange = function (value) { return value !== null && typeof value === 'object' && whole(value.from, 1) && whole(value.to, value.from) && whole(value.rows, 1); };
  const found = data.read_plan;
  if (!Array.isArray(found) || found.length !== 1 || found[0] === null || typeof found[0] !== 'object') {
    throw new Error('read_plan must answer the one coordination status row.');
  }
  const status = found[0];
  const refuse = function (reason) {
    throw new Error('Page ' + page.token + ' ' + reason + '; nothing was counted.');
  };
  if (status.claim_token !== page.claim) {
    refuse('names a claim that is not the current claim');
  }
  if (status.claim_domain !== 'enrollments') {
    refuse('needs an enrollments claim, and the current claim runs ' + String(status.claim_domain));
  }
  if (status.claim_revision !== page.revision) {
    refuse('names revision ' + page.revision + ', and the claim runs at revision ' + String(status.claim_revision));
  }
  const pages = Array.isArray(status.claim_pages) ? status.claim_pages : [];
  const planned = pages.filter(function (entry) {
    return entry !== null && typeof entry === 'object' && entry.token === page.token;
  });
  if (planned.length !== 1) {
    refuse('is not planned under this claim (plan_pages with source enrollments)');
  }
  const entry = planned[0];
  const kindOf = function (value) { return typeof value.kind === 'string' ? value.kind : 'rules'; };`;

const pageTrigger = String.raw`
  if (page === null || typeof page !== 'object' || typeof page.claim !== 'string' || page.claim.length === 0 || typeof page.token !== 'string' || !/^p\d{4,9}$/u.test(page.token)) {
    throw new Error('The page needs its planned range, claim and revision as its trigger payload.');
  }`;

// check_page of "Data / Count legacy rules page": $trigger is one legacy
// page of the plan plus the claim and its revision. It answers the users
// and rules ranges as planned, with the history and pattern bytes the plan
// measured; only those ranges are read.
export const legacyPageCheckScript = `module.exports = function (data) {
  const page = data.$trigger;${pageTrigger}
  if (!Number.isSafeInteger(page.bytes) || page.bytes < 0 || !Number.isSafeInteger(page.revision) || page.revision < 0 || page.rules === null || typeof page.rules !== 'object' || !Number.isSafeInteger(page.rules.bytes) || page.rules.bytes < 0) {
    throw new Error('The ranges, bytes and revision of page ' + page.token + ' must be integers.');
  }${pageStatus}
  if (entry.kind !== 'legacy') {
    refuse('is planned as a ' + kindOf(entry) + ' page, not a legacy page');
  }
  const rules = entry.rules !== null && typeof entry.rules === 'object' ? entry.rules : {};
  const same = entry.from === page.from && entry.to === page.to && entry.rows === page.rows && entry.bytes === page.bytes && rules.from === page.rules.from && rules.to === page.rules.to && rules.rows === page.rules.rows && rules.bytes === page.rules.bytes;
  if (!same || !isRange(entry) || !isRange(rules)) {
    refuse('was planned as users ' + String(entry.from) + ' to ' + String(entry.to) + ' (' + String(entry.rows) + ', ' + String(entry.bytes) + ' bytes) with rules ' + String(rules.from) + ' to ' + String(rules.to) + ' (' + String(rules.rows) + ', ' + String(rules.bytes) + ' bytes)');
  }
  return { claim: page.claim, revision: page.revision, rules: { bytes: rules.bytes, from: rules.from, rows: rules.rows, to: rules.to }, token: page.token, users: { bytes: entry.bytes, from: entry.from, rows: entry.rows, to: entry.to } };
};`;

// check_zeros of "Data / Fill legacy rule zeros": $trigger is one zero
// page (a legacy rule page) plus the claim and its revision. It answers
// the page with the tokens of its legacy pages, all of which must be
// staged already: the native sum reads those pages only.
export const zeroPageCheckScript = `module.exports = function (data) {
  const page = data.$trigger;${pageTrigger}
  if (!Number.isSafeInteger(page.revision) || page.revision < 0) {
    throw new Error('The revision of page ' + page.token + ' must be an integer.');
  }${pageStatus}
  if (entry.kind !== 'legacy_zeros') {
    refuse('is planned as a ' + kindOf(entry) + ' page, not a zero page');
  }
  if (!isRange(page) || entry.from !== page.from || entry.to !== page.to || entry.rows !== page.rows) {
    refuse('was planned as rules ' + String(entry.from) + ' to ' + String(entry.to) + ' (' + String(entry.rows) + ')');
  }
  const cells = pages.filter(function (other) {
    return other !== null && typeof other === 'object' && other.kind === 'legacy' && other.rules !== null && typeof other.rules === 'object' && other.rules.from === page.from && other.rules.to === page.to && other.rules.rows === page.rows;
  }).map(function (other) { return other.token; });
  const staged = Array.isArray(status.claim_staged) ? status.claim_staged : [];
  const missing = cells.filter(function (token) { return !staged.includes(token); });
  if (missing.length > 0) {
    refuse('runs before ' + missing.length + ' of its ' + cells.length + ' legacy pages ' + (missing.length === 1 ? 'was' : 'were') + ' staged');
  }
  return { cells: cells, claim: page.claim, from: page.from, revision: page.revision, rows: page.rows, to: page.to, token: page.token };
};`;

// legacy_pages of "Data / Count legacy enrollments": the legacy pages and
// zero pages of the enrollments plan of the current claim, each with the
// claim and its revision, in plan order. An empty plan (no rule at all)
// lists none; a plan without page kinds is not an enrollments plan.
export const legacyPagesScript = `module.exports = function (data) {
  const trigger = data.$trigger;
  if (trigger === null || typeof trigger !== 'object' || typeof trigger.claim !== 'string' || trigger.claim.length === 0) {
    throw new Error('The legacy count needs the claim token (claim) as its trigger payload.');
  }
  const found = data.read_plan;
  if (!Array.isArray(found) || found.length !== 1 || found[0] === null || typeof found[0] !== 'object') {
    throw new Error('read_plan must answer the one coordination status row.');
  }
  const status = found[0];
  const refuse = function (reason) { throw new Error(reason + '; nothing was counted.'); };
  if (status.claim_token !== trigger.claim) {
    refuse('The legacy count names a claim that is not the current claim');
  }
  if (status.claim_domain !== 'enrollments') {
    refuse('The legacy count needs an enrollments claim, and the current claim runs ' + String(status.claim_domain));
  }
  const pages = status.claim_pages;
  const typed = Array.isArray(pages) && pages.every(function (entry) { return entry !== null && typeof entry === 'object' && typeof entry.kind === 'string'; });
  if (!typed) {
    refuse('The claim has no enrollments plan (plan_pages with source enrollments)');
  }
  const revision = status.claim_revision;
  const cells = [];
  const zeros = [];
  for (const entry of pages) {
    const rules = entry.rules !== null && typeof entry.rules === 'object' ? entry.rules : {};
    if (entry.kind === 'legacy') {
      cells.push({ bytes: entry.bytes, claim: trigger.claim, from: entry.from, revision: revision, rows: entry.rows, rules: { bytes: rules.bytes, from: rules.from, rows: rules.rows, to: rules.to }, to: entry.to, token: entry.token });
    } else if (entry.kind === 'legacy_zeros') {
      zeros.push({ claim: trigger.claim, from: entry.from, revision: revision, rows: entry.rows, to: entry.to, token: entry.token });
    }
  }
  return { cells: cells, revision: revision, zeros: zeros };
};`;

// Shared check of the answers a serial Trigger Flow gave for a page list:
// the first failure record becomes the refusal, cut to a bounded length.
const answersOf = (list: string, results: string, noun: string) => `
  const listed = data.legacy_pages !== null && typeof data.legacy_pages === 'object' && Array.isArray(data.legacy_pages.${list}) ? data.legacy_pages.${list} : null;
  const results = data.${results};
  if (listed === null || !Array.isArray(results) || results.length !== listed.length) {
    throw new Error('${results} answered ' + (Array.isArray(results) ? results.length : 'no') + ' results for ' + (listed === null ? 'no' : listed.length) + ' ${noun} pages.');
  }
  const answer = function (index, page) {
    const result = results[index];
    if (result !== null && typeof result === 'object' && result.ok === false) {
      const cause = (String(result.stage) + ': ' + String(result.code) + ' ' + String(result.message)).slice(0, 320);
      throw new Error('${noun === 'legacy' ? 'Legacy' : 'Zero'} page ' + page.token + ' failed (' + cause + ')');
    }
    if (result === null || typeof result !== 'object' || result.page !== page.token) {
      throw new Error('${noun === 'legacy' ? 'Legacy' : 'Zero'} page ' + page.token + ' answered no valid summary.');
    }
    return result;
  };
  const whole = function (value) { return Number.isSafeInteger(value) && value >= 0; };`;

// check_pages: every legacy page answered its own summary with the users
// and rules it was planned with; answers the pages and staged rows.
export const legacyPagesCheckScript = `module.exports = function (data) {${answersOf('cells', 'count_pages', 'legacy')}
  let staged = 0;
  for (const [index, page] of listed.entries()) {
    const result = answer(index, page);
    const rules = page.rules !== null && typeof page.rules === 'object' ? page.rules.rows : null;
    if (result.users !== page.rows || result.rules !== rules || !whole(result.staged) || result.staged > rules) {
      throw new Error('Legacy page ' + page.token + ' answered no valid summary.');
    }
    staged += result.staged;
  }
  return { pages: listed.length, staged: staged };
};`;

// check_fills: every zero page answered its rules as counted or zero, and
// staged exactly its zeros; answers the totals.
export const zeroPagesCheckScript = `module.exports = function (data) {${answersOf('zeros', 'fill_zeros', 'zero')}
  const totals = { counted: 0, pages: listed.length, pairs: 0, zeros: 0 };
  for (const [index, page] of listed.entries()) {
    const result = answer(index, page);
    const valid = result.rules === page.rows && whole(result.counted) && whole(result.zeros) && result.counted + result.zeros === page.rows && result.staged === result.zeros;
    if (!valid) {
      throw new Error('Zero page ' + page.token + ' answered no valid summary.');
    }
    totals.counted += result.counted;
    totals.pairs += result.rules;
    totals.zeros += result.zeros;
  }
  return totals;
};`;
