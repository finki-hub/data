import { plannedPageScript, statusRowScript } from './plan-check-scripts.js';
import { legacyPageKind, scriptText, zeroPageKind } from './shared.js';
import {
  countFragment,
  payloadRefusal,
  refuseFragment,
  relayFragment,
} from './text-fragments.js';

// The small Run Script bodies of the legacy enrollment Flows that check
// the stored plan and the answers of the child Flows. The two bodies that
// touch data, count-history-page.cjs and sum-counts.cjs, live in
// directus/flows. stage_page checks only that a page token is planned, so
// every page checks itself against the plan the coordinator stored for
// the claim (kind, ranges, bytes and revision) before it reads a row, and
// no refusal names a claim token, a history, a pattern or a name. The two
// page kinds are the legacy_regex family's declared ones (rule-modes.ts).

const legacyKind = scriptText(legacyPageKind);

const zeroKind = scriptText(zeroPageKind);

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

// Shared start of the page checks, after the trigger payload check: the
// helpers, the one status row, the current enrollments claim at the page's
// revision and the page's one plan entry (plan-check-scripts.ts).
const pageStatus = `
  const isRange = function (value) { return value !== null && typeof value === 'object' && whole(value.from, 1) && whole(value.to, value.from) && whole(value.rows, 1); };${statusRowScript}${plannedPageScript}
  const kindOf = function (value) { return typeof value.kind === 'string' ? value.kind : 'rules'; };`;

// The start of a page check: the refusal helper and the claim and token of
// the trigger payload, refused by the payload `keys` it expects.
const pageTrigger = (keys: readonly string[]): string => String.raw`
  ${refuseFragment}
  ${countFragment}
  const page = data.$trigger;
  const whole = function (value, least) { return Number.isSafeInteger(value) && value >= least; };
  if (page === null || typeof page !== 'object' || typeof page.claim !== 'string' || page.claim.length === 0 || typeof page.token !== 'string' || !/^p\d{4,9}$/u.test(page.token)) {
    ${payloadRefusal(keys)}
  }`;

// check_page of "Data / Count legacy rules page": $trigger is one legacy
// page of the plan plus the claim and its revision. It answers the users
// and rules ranges as planned, with the history and pattern bytes the plan
// measured; only those ranges are read.
export const legacyPageCheckScript = `module.exports = function (data) {${pageTrigger(['claim', 'token', 'from', 'to', 'rows', 'bytes', 'rules', 'revision'])}
  if (!whole(page.bytes, 0) || !whole(page.revision, 0) || page.rules === null || typeof page.rules !== 'object' || !whole(page.rules.bytes, 0)) {
    refuse('Invalid trigger payload', 'page ' + page.token + ': from, to, rows, bytes, rules, revision must be integers');
  }${pageStatus}
  if (planned.kind !== ${legacyKind}) {
    refuse(place, 'kind ' + kindOf(planned) + ', expected ${legacyPageKind}');
  }
  const rules = planned.rules !== null && typeof planned.rules === 'object' ? planned.rules : {};
  const same = planned.from === page.from && planned.to === page.to && planned.rows === page.rows && planned.bytes === page.bytes && rules.from === page.rules.from && rules.to === page.rules.to && rules.rows === page.rules.rows && rules.bytes === page.rules.bytes;
  if (!same || !isRange(planned) || !isRange(rules)) {
    refuse(place, 'range differs from plan: users ' + String(planned.from) + '-' + String(planned.to) + ' (' + counted(planned.rows, 'row', 'rows') + ', ' + counted(planned.bytes, 'byte', 'bytes') + '), rules ' + String(rules.from) + '-' + String(rules.to) + ' (' + counted(rules.rows, 'row', 'rows') + ', ' + counted(rules.bytes, 'byte', 'bytes') + ')');
  }
  return { claim: page.claim, revision: page.revision, rules: { bytes: rules.bytes, from: rules.from, rows: rules.rows, to: rules.to }, token: page.token, users: { bytes: planned.bytes, from: planned.from, rows: planned.rows, to: planned.to } };
};`;

// check_zeros of "Data / Fill legacy rule zeros": $trigger is one zero
// page (a legacy rule page) plus the claim and its revision. It answers
// the page with the tokens of its legacy pages, all of which must be
// staged already: the native sum reads those pages only.
export const zeroPageCheckScript = `module.exports = function (data) {${pageTrigger(['claim', 'token', 'from', 'to', 'rows', 'revision'])}
  if (!whole(page.revision, 0)) {
    refuse('Invalid trigger payload', 'page ' + page.token + ': revision must be an integer');
  }${pageStatus}
  if (planned.kind !== ${zeroKind}) {
    refuse(place, 'kind ' + kindOf(planned) + ', expected ${zeroPageKind}');
  }
  if (!isRange(page) || planned.from !== page.from || planned.to !== page.to || planned.rows !== page.rows) {
    refuse(place, 'range differs from plan: rules ' + String(planned.from) + '-' + String(planned.to) + ' (' + counted(planned.rows, 'row', 'rows') + ')');
  }
  const cells = pages.filter(function (other) {
    return other !== null && typeof other === 'object' && other.kind === ${legacyKind} && other.rules !== null && typeof other.rules === 'object' && other.rules.from === page.from && other.rules.to === page.to && other.rules.rows === page.rows;
  }).map(function (other) { return other.token; });
  const staged = Array.isArray(status.claim_staged) ? status.claim_staged : [];
  const missing = cells.filter(function (token) { return !staged.includes(token); });
  if (missing.length > 0) {
    refuse(place, 'legacy pages not staged: ' + missing.length + ' of ' + cells.length);
  }
  return { cells: cells, claim: page.claim, from: page.from, revision: page.revision, rows: page.rows, to: page.to, token: page.token };
};`;

// legacy_pages of "Data / Count legacy enrollments": the legacy pages and
// zero pages of the enrollments plan of the current claim, each with the
// claim and its revision, in plan order. An empty plan (no rule at all)
// lists none; a plan without page kinds is not an enrollments plan.
export const legacyPagesScript = `module.exports = function (data) {
  ${refuseFragment}
  const trigger = data.$trigger;
  if (trigger === null || typeof trigger !== 'object' || typeof trigger.claim !== 'string' || trigger.claim.length === 0) {
    ${payloadRefusal(['claim'])}
  }${statusRowScript}
  const claimed = claimFault(trigger.claim);
  if (claimed !== null) {
    refuse('Legacy count', claimed);
  }
  const pages = status.claim_pages;
  const typed = Array.isArray(pages) && pages.every(function (entry) { return entry !== null && typeof entry === 'object' && typeof entry.kind === 'string'; });
  if (!typed) {
    refuse('Legacy count', 'no enrollments plan');
  }
  const revision = status.claim_revision;
  const cells = [];
  const zeros = [];
  for (const entry of pages) {
    const rules = entry.rules !== null && typeof entry.rules === 'object' ? entry.rules : {};
    if (entry.kind === ${legacyKind}) {
      cells.push({ bytes: entry.bytes, claim: trigger.claim, from: entry.from, revision: revision, rows: entry.rows, rules: { bytes: rules.bytes, from: rules.from, rows: rules.rows, to: rules.to }, to: entry.to, token: entry.token });
    } else if (entry.kind === ${zeroKind}) {
      zeros.push({ claim: trigger.claim, from: entry.from, revision: revision, rows: entry.rows, to: entry.to, token: entry.token });
    }
  }
  return { cells: cells, revision: revision, zeros: zeros };
};`;

// Shared check of the answers a serial Trigger Flow gave for a page list:
// the first failure record becomes the refusal, relayed with its stage and
// code and cut to a bounded length.
const answersOf = (list: string, results: string, subject: string) => `
  ${refuseFragment}
  ${relayFragment}
  const listed = data.legacy_pages !== null && typeof data.legacy_pages === 'object' && Array.isArray(data.legacy_pages.${list}) ? data.legacy_pages.${list} : null;
  const results = data.${results};
  if (listed === null || !Array.isArray(results) || results.length !== listed.length) {
    refuse('${results}', 'results ' + (Array.isArray(results) ? results.length : 'none') + ', expected ' + (listed === null ? 'none' : listed.length));
  }
  const invalid = function (page) { refuse('${subject} ' + page.token, 'invalid summary'); };
  const answer = function (index, page) {
    const result = results[index];
    if (result !== null && typeof result === 'object' && result.ok === false) {
      throw new Error(relayed('${subject} ' + page.token, result));
    }
    if (result === null || typeof result !== 'object' || result.page !== page.token) {
      invalid(page);
    }
    return result;
  };
  const whole = function (value) { return Number.isSafeInteger(value) && value >= 0; };`;

// check_pages: every legacy page answered its own summary with the users
// and rules it was planned with; answers the pages and staged rows.
export const legacyPagesCheckScript = `module.exports = function (data) {${answersOf('cells', 'count_pages', 'Legacy page')}
  let staged = 0;
  for (const [index, page] of listed.entries()) {
    const result = answer(index, page);
    const rules = page.rules !== null && typeof page.rules === 'object' ? page.rules.rows : null;
    if (result.users !== page.rows || result.rules !== rules || !whole(result.staged) || result.staged > rules) {
      invalid(page);
    }
    staged += result.staged;
  }
  return { pages: listed.length, staged: staged };
};`;

// check_fills: every zero page answered its rules as counted or zero, and
// staged exactly its zeros; answers the totals.
export const zeroPagesCheckScript = `module.exports = function (data) {${answersOf('zeros', 'fill_zeros', 'Zero page')}
  const totals = { counted: 0, pages: listed.length, pairs: 0, zeros: 0 };
  for (const [index, page] of listed.entries()) {
    const result = answer(index, page);
    const valid = result.rules === page.rows && whole(result.counted) && whole(result.zeros) && result.counted + result.zeros === page.rows && result.staged === result.zeros;
    if (!valid) {
      invalid(page);
    }
    totals.counted += result.counted;
    totals.pairs += result.rules;
    totals.zeros += result.zeros;
  }
  return totals;
};`;
