// Flow pieces the enrollment count Flows share: the Flow family ids, the
// failure record of a count step, the check of a page against the claim's
// stored plan, the rule page that names the course/year pairs of one
// planned page, and the check that turns the per-pair results
// {course, academic_year, count, revision} into the candidate rows of that
// page. The install-once helpers themselves live in flow-template.ts and
// install-flows.ts (Tasks 9 and 10) and are reused, not copied. The rule
// modes, their page kinds and the runner of each family are declared once
// in the data-operations extension (rule-modes.ts); the Flows of a family
// read their own declaration.
import { ruleMode } from '../../directus/extensions/directus-extension-data-operations/src/rule-modes.js';
import { familyIds, familyStep, flowFamilyCodes } from './flow-template.js';

// A declared mode or page kind as a string literal inside a Run Script
// body. The registry test keeps every declared value to lowercase words
// and underscores, so the literal needs no escaping.
export const scriptText = (value: string): string => `'${value}'`;

// The mapped_entries family: its rule mode and its one page kind.
export const mappedRuleMode = ruleMode('mapped_entries');

export const [mappedPageKind] = mappedRuleMode.pageKinds;

// The legacy_regex family: its rule mode and its two page kinds (a history
// page crossed with a rule page, and the zero page of a rule page).
export const legacyRuleMode = ruleMode('legacy_regex');

export const [legacyPageKind, zeroPageKind] = legacyRuleMode.pageKinds;

export const enrollmentFamily = flowFamilyCodes.mapped;

// A deterministic UUID of the enrollment count Flow family.
export const enrollmentId = familyIds(enrollmentFamily);

// An operation of the enrollment count family.
export const enrollmentStep = familyStep(enrollmentFamily);

// The mapped enrollment Flows: one course/year, one planned rule page, and
// the family's runner (every mapped page of the plan), whose id the
// registry declares.
export const mappedEnrollmentFlowIds = {
  page: enrollmentId('02'),
  pages: mappedRuleMode.runnerFlowId,
  pair: enrollmentId('01'),
} as const;

const legacyFamily = flowFamilyCodes.legacy;

// A deterministic UUID of the legacy enrollment Flow family.
export const legacyId = familyIds(legacyFamily);

// An operation of the legacy enrollment family.
export const legacyStep = familyStep(legacyFamily);

// The legacy enrollment Flows: the parent (the family's runner, whose id
// the registry declares), one legacy page (a history page crossed with a
// legacy rule page), one zero page (a legacy rule page).
export const legacyEnrollmentFlowIds = {
  page: legacyId('02'),
  parent: legacyRuleMode.runnerFlowId,
  zeros: legacyId('03'),
} as const;

// The code every legacy Flow fails its claim with.
export const legacyFailureCode = 'LEGACY_COUNT_FAILED';

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
// must be planned under it with exactly this range and row count, as a
// page of a `rules` plan or a mapped page of an `enrollments` plan (never a
// legacy or zero page of the legacy family). Answers
// the page as planned, and only that range is read. stage_page checks no
// more than that the token is planned, so a consistent payload of a
// sub-range, another page's range under this token or a claim of another
// domain would otherwise be staged as the whole page.
export const pagePlanScript = String.raw`module.exports = function (data) {
  const page = data.$trigger;
  const whole = function (value, least) { return Number.isSafeInteger(value) && value >= least; };
  if (page === null || typeof page !== 'object' || typeof page.claim !== 'string' || page.claim.length === 0 || typeof page.token !== 'string' || !/^p\d{4,9}$/u.test(page.token)) {
    throw new Error('The page needs {claim, token, from, to, rows, revision} as its trigger payload.');
  }
  if (!whole(page.from, 1) || !whole(page.to, page.from) || !whole(page.rows, 0) || !whole(page.revision, 0)) {
    throw new Error('The range, row count and revision of page ' + page.token + ' must be integers.');
  }
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
  const planned = (Array.isArray(status.claim_pages) ? status.claim_pages : []).filter(function (entry) {
    return entry !== null && typeof entry === 'object' && entry.token === page.token;
  });
  if (planned.length !== 1) {
    refuse('is not planned with its range under this claim (plan_pages with source enrollments or rules)');
  }
  const range = planned[0];
  if (range.kind !== undefined && range.kind !== ${scriptText(mappedPageKind)}) {
    refuse('is planned as a ' + String(range.kind) + ' page, not a mapped rule page');
  }
  if (range.from !== page.from || range.to !== page.to || range.rows !== page.rows) {
    refuse('was planned as ids ' + String(range.from) + ' to ' + String(range.to) + ' (' + String(range.rows) + ' rules), not ' + page.from + ' to ' + page.to + ' (' + page.rows + ')');
  }
  return { claim: page.claim, from: range.from, revision: page.revision, rows: range.rows, to: range.to, token: page.token };
};`;

// The mapped rules of the planned page (check_page), read whole: the check
// below compares their number with the plan, so a read cut short by
// QUERY_LIMIT_MAX can never pass as a smaller page. An enrollments plan
// cuts mapped pages from the mapped_entries rules alone, so legacy rules
// may lie inside the id range and are left out here; a `rules` plan counts
// every rule of the range, so a legacy rule there makes the read shorter
// than planned and refuses the page.
export const rulePageQuery = {
  fields: ['id', 'course', 'academic_year', 'mode'],
  filter: {
    id: { _between: ['{{ check_page.from }}', '{{ check_page.to }}'] },
    mode: { _eq: mappedRuleMode.mode },
  },
  limit: -1,
  sort: ['id'],
} as const;

// Checks that read_rules holds exactly the rules of the planned page
// (check_page) and answers one payload {course, academic_year, revision,
// claim} per rule, in rule order. Every rule must have the mode
// mapped_entries: stage_page replaces a page whole and the completion
// replaces every course_enrollments row, so staging only the mapped rules
// of a page that also holds a legacy_regex rule would drop that pair's
// count. Such a page is refused until one page step stages every mode.
export const rulePairsScript = `module.exports = function (data) {
  const page = data.check_page;
  const whole = function (value, least) { return Number.isSafeInteger(value) && value >= least; };
  if (page === null || typeof page !== 'object' || !whole(page.from, 1) || !whole(page.to, page.from) || !whole(page.rows, 0) || !whole(page.revision, 0)) {
    throw new Error('check_page answered no planned page; nothing was counted.');
  }
  const rules = data.read_rules;
  if (!Array.isArray(rules)) {
    throw new Error('read_rules returned no rule list.');
  }
  if (rules.length !== page.rows) {
    throw new Error('Read ' + rules.length + ' rules of page ' + page.token + ', planned ' + page.rows + '; nothing was counted.');
  }
  const seen = new Set();
  const pairs = [];
  for (const rule of rules) {
    if (rule === null || typeof rule !== 'object' || !whole(rule.id, page.from) || rule.id > page.to || seen.has(rule.id)) {
      throw new Error('read_rules answered a rule outside page ' + page.token + '.');
    }
    seen.add(rule.id);
    if (!whole(rule.course, 1) || !whole(rule.academic_year, 1)) {
      throw new Error('Rule ' + rule.id + ' has no course or academic year id.');
    }
    if (rule.mode !== ${scriptText(mappedRuleMode.mode)}) {
      throw new Error('Rule ' + rule.id + ' of page ' + page.token + ' has the mode ' + String(rule.mode) + '; this Flow counts ${mappedRuleMode.mode} rules only and stages a page whole, so nothing was counted.');
    }
    pairs.push({ academic_year: rule.academic_year, claim: page.claim, course: rule.course, revision: page.revision });
  }
  return pairs;
};`;

// Turns the per-pair results of a page into its candidate rows, in pair
// order. The whole page is refused when any pair answered a failure record,
// nothing, another pair, another revision or anything but a non-negative
// integer count: a failed pair is never staged as zero, and a successful
// zero is staged like any other count. The message names the pair by its
// ids and cuts the cause to a bounded length.
export const candidateRowsScript = `module.exports = function (data) {
  const pairs = data.pair_payloads;
  const results = data.count_pairs;
  if (!Array.isArray(pairs) || !Array.isArray(results) || results.length !== pairs.length) {
    throw new Error('count_pairs answered ' + (Array.isArray(results) ? results.length : 'no') + ' results for ' + (Array.isArray(pairs) ? pairs.length : 'no') + ' pairs; nothing was staged.');
  }
  return pairs.map(function (pair, index) {
    const result = results[index];
    const label = 'course ' + pair.course + ' / academic year ' + pair.academic_year;
    if (result === null || typeof result !== 'object') {
      throw new Error('No count for ' + label + '; nothing was staged.');
    }
    if (result.ok === false) {
      const cause = (String(result.stage) + ': ' + String(result.code) + ' ' + String(result.message)).slice(0, 320);
      throw new Error('The count for ' + label + ' failed (' + cause + '); nothing was staged.');
    }
    const valid = result.course === pair.course && result.academic_year === pair.academic_year && result.revision === pair.revision && Number.isSafeInteger(result.count) && result.count >= 0;
    if (!valid) {
      throw new Error('The count for ' + label + ' is not a valid result; nothing was staged.');
    }
    return { academic_year: pair.academic_year, count: result.count, course: pair.course };
  });
};`;
