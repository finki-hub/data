import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { runAction } from '../directus/extensions/directus-extension-data-operations/src/coordination/actions.js';
import { installSql } from '../directus/extensions/directus-extension-data-operations/src/coordination/sql-statements.js';
import {
  type EnrollmentFamily,
  planEnrollmentFamilies,
} from '../directus/extensions/directus-extension-data-operations/src/enrollment-pages.js';
import { enrollmentLimits } from '../directus/extensions/directus-extension-data-operations/src/enrollment-ranges.js';
import {
  alternatives,
  ruleMode,
  ruleModeNames,
  ruleModes,
  type RuleModeSpec,
  rulePlanners,
  rulesPlanMode,
  runnerFlowIds,
} from '../directus/extensions/directus-extension-data-operations/src/rule-modes.js';
import { operationsCollections } from '../src/data-model/operations-collections.js';
import { modeChoices } from '../src/data-model/operations-vocabularies.js';
import { flowFamilies } from '../src/flows/registry.js';
import {
  legacyEnrollmentFlowIds,
  mappedEnrollmentFlowIds,
  rulePageQuery,
} from '../src/flows/shared.js';
import { FakeCoordination } from './data-coordination-helpers.js';
import { claimEnrollments, context } from './legacy-enrollment-helpers.js';

// plan_pages over the persistence port for enrollments claims: the one
// plan of every rule family (source enrollments), its completion, and the
// pairing of every table source with its own claim domain; the rule-mode
// registry and the planner it drives. The page cutting and the page
// scripts are in legacy-enrollment-flow.test.ts.

const rulesTable = /course_enrollment_rules/u;
const installsFromCandidates =
  /FROM "data_operation_results" WHERE "claim_token" = \?/u;

type StagedPage = {
  readonly page: string;
  readonly rows: ReadonlyArray<{
    academic_year: number;
    count: number;
    course: number;
  }>;
  readonly token: string;
};

const stageRows = (fake: FakeCoordination, { page, rows, token }: StagedPage) =>
  runAction(
    { action: 'stage_page', page, rows: [...rows], token },
    context(fake),
  );

const complete = (fake: FakeCoordination, token: string) =>
  runAction({ action: 'complete', token }, context(fake));

describe('plan_pages with source enrollments', () => {
  const sources = {
    rules: [
      { bytes: 0, id: 1, mode: 'mapped_entries' },
      { bytes: 7, id: 2, mode: 'legacy_regex' },
      { bytes: 8, id: 3, mode: 'legacy_regex' },
    ],
    users: [
      { bytes: 10, id: 5 },
      { bytes: 0, id: 6 },
    ],
  };

  test('holds both families in one plan; completion needs every page and installs the staged counts', async () => {
    const fake = new FakeCoordination();
    fake.enrollmentSources = sources;
    const token = await claimEnrollments(fake);

    await expect(
      runAction(
        { action: 'plan_pages', source: 'enrollments', token },
        context(fake),
      ),
    ).resolves.toEqual({
      discarded: 0,
      families: [
        {
          kind: 'mapped_entries',
          pages: [{ from: 1, kind: 'mapped', rows: 1, to: 1, token: 'p0001' }],
          runnerFlowId: ruleMode('mapped_entries').runnerFlowId,
        },
        {
          kind: 'legacy_regex',
          pages: [
            {
              bytes: 10,
              from: 5,
              kind: 'legacy',
              rows: 2,
              rules: { bytes: 15, from: 2, rows: 2, to: 3 },
              to: 6,
              token: 'p0002',
            },
            { from: 2, kind: 'legacy_zeros', rows: 2, to: 3, token: 'p0003' },
          ],
          runnerFlowId: ruleMode('legacy_regex').runnerFlowId,
        },
      ],
      source: 'enrollments',
      total: 3,
    });
    // The claim keeps every page of every family for its completion.
    expect(fake.data.claim?.pages).toEqual(['p0001', 'p0002', 'p0003']);

    // The mapped family alone is refused, never installed.
    await stageRows(fake, {
      page: 'p0001',
      rows: [{ academic_year: 1, count: 2, course: 1 }],
      token,
    });

    await expect(complete(fake, token)).rejects.toMatchObject({
      code: 'COORDINATION_PAGES_MISSING',
      extensions: { missing: ['p0002', 'p0003'] },
    });

    // The legacy page stages nonzero partial counts; without its zero
    // page the run is still incomplete.
    await stageRows(fake, {
      page: 'p0002',
      rows: [{ academic_year: 1, count: 1, course: 2 }],
      token,
    });

    await expect(complete(fake, token)).rejects.toMatchObject({
      extensions: { missing: ['p0003'] },
    });
    expect(fake.data.enrollments).toEqual([]);

    await stageRows(fake, {
      page: 'p0003',
      rows: [{ academic_year: 1, count: 0, course: 3 }],
      token,
    });

    await expect(complete(fake, token)).resolves.toMatchObject({
      installed: 3,
    });
    expect(
      fake.data.enrollments.map(({ count: value, course }) => [course, value]),
    ).toEqual([
      [1, 2],
      [2, 1],
      [3, 0],
    ]);
  });

  // The zero-fill decision: the completion sums the staged candidates of
  // the claim and never reads the rule list, so a legacy pair appears only
  // when a page staged a row for it; the zero page stages those rows.
  test('installs only staged pairs: the completion never fills zeros itself', async () => {
    const fake = new FakeCoordination();
    fake.enrollmentSources = sources;
    const token = await claimEnrollments(fake);
    await runAction(
      { action: 'plan_pages', source: 'enrollments', token },
      context(fake),
    );
    await stageRows(fake, {
      page: 'p0001',
      rows: [{ academic_year: 1, count: 2, course: 1 }],
      token,
    });
    await stageRows(fake, { page: 'p0002', rows: [], token });
    await stageRows(fake, { page: 'p0003', rows: [], token });

    await expect(complete(fake, token)).resolves.toMatchObject({
      installed: 1,
    });
    expect(fake.data.enrollments.map(({ course }) => course)).toEqual([1]);
    expect(installSql).not.toMatch(rulesTable);
    expect(installSql).toMatch(installsFromCandidates);
  });

  test('refuses an enrollments plan under a claim of another domain', async () => {
    const fake = new FakeCoordination();
    fake.enrollmentSources = sources;
    const history = await runAction(
      { action: 'claim', domain: 'history_index', retry: false },
      context(fake),
    );
    const token = z.object({ token: z.string() }).parse(history).token;

    await expect(
      runAction(
        { action: 'plan_pages', source: 'enrollments', token },
        context(fake),
      ),
    ).rejects.toMatchObject({ code: 'COORDINATION_DOMAIN_MISMATCH' });
  });

  test('refuses to plan over budget and leaves the claim unplanned', async () => {
    const fake = new FakeCoordination();
    fake.enrollmentSources = {
      ...sources,
      users: [{ bytes: 800_001, id: 17 }],
    };
    const token = await claimEnrollments(fake);

    await expect(
      runAction(
        { action: 'plan_pages', source: 'enrollments', token },
        context(fake),
      ),
    ).rejects.toMatchObject({ code: 'COORDINATION_PAGE_OVER_BUDGET' });
    expect(fake.data.claim?.pages).toBeNull();
    await expect(complete(fake, token)).rejects.toMatchObject({
      code: 'COORDINATION_PAGES_MISSING',
    });
  });
});

const historyUnderEnrollments =
  /^plan_pages with source history serves history_index claims only; the current claim runs enrollments, which plans with source enrollments\.$/u;
const rulesWithLegacy =
  /^plan_pages with source rules plans mapped_entries rules only, and rule (?:2|4) has another mode; plan with source enrollments, which covers every rule mode\. Nothing was planned\.$/u;
const rulesUnderHistory =
  /^plan_pages with source rules serves enrollments claims only; the current claim runs history_index\.$/u;
const domainMismatch = { code: 'COORDINATION_DOMAIN_MISMATCH' };

const plan = (
  fake: FakeCoordination,
  source: 'enrollments' | 'history' | 'rules',
  token: string,
) => runAction({ action: 'plan_pages', source, token }, context(fake));

// A plan without the legacy family would let the completion, which
// replaces every installed count, drop that family's rows: an enrollments
// claim plans users never, and rules only while every rule is mapped.
describe('plan_pages sources by claim domain', () => {
  const legacySources = {
    rules: [
      { bytes: 0, id: 1, mode: 'mapped_entries' },
      { bytes: 7, id: 2, mode: 'legacy_regex' },
    ],
    users: [{ bytes: 10, id: 5 }],
  };

  test('refuses history and rules plans of an enrollments claim with legacy rules, which stays unplanned', async () => {
    const fake = new FakeCoordination();
    fake.enrollmentSources = legacySources;
    fake.data.enrollments.push({
      academic_year: 1,
      count: 4,
      course: 2,
      revision: 0,
    });
    const token = await claimEnrollments(fake);
    fake.sourceIds.history = [5];
    fake.sourceIds.rules = [1, 2];

    await expect(plan(fake, 'history', token)).rejects.toMatchObject(
      domainMismatch,
    );
    await expect(plan(fake, 'history', token)).rejects.toThrow(
      historyUnderEnrollments,
    );
    await expect(plan(fake, 'rules', token)).rejects.toMatchObject(
      domainMismatch,
    );
    await expect(plan(fake, 'rules', token)).rejects.toThrow(rulesWithLegacy);
    expect(fake.data.claim?.pages).toBeNull();
    await expect(complete(fake, token)).rejects.toMatchObject({
      code: 'COORDINATION_PAGES_MISSING',
    });
    // Nothing replaced the installed legacy pair.
    expect(fake.data.enrollments).toHaveLength(1);
    await expect(plan(fake, 'enrollments', token)).resolves.toMatchObject({
      total: 3,
    });
  });

  test('refuses an empty history plan of an enrollments claim too', async () => {
    const fake = new FakeCoordination();
    fake.enrollmentSources = { ...legacySources, users: [] };
    const token = await claimEnrollments(fake);

    await expect(plan(fake, 'history', token)).rejects.toMatchObject(
      domainMismatch,
    );
    await expect(complete(fake, token)).rejects.toMatchObject({
      code: 'COORDINATION_PAGES_MISSING',
    });
  });

  test('plans the rules of an enrollments claim while every rule is mapped_entries', async () => {
    const fake = new FakeCoordination();
    fake.enrollmentSources = {
      rules: [
        { bytes: 0, id: 1, mode: 'mapped_entries' },
        { bytes: 0, id: 3, mode: 'mapped_entries' },
      ],
      users: [],
    };
    fake.sourceIds.rules = [1, 3];
    const token = await claimEnrollments(fake);

    await expect(plan(fake, 'rules', token)).resolves.toMatchObject({
      pages: [{ from: 1, rows: 2, to: 3, token: 'p0001' }],
      source: 'rules',
    });

    // A rule of no known mode is not mapped either.
    fake.enrollmentSources = {
      ...fake.enrollmentSources,
      rules: [...fake.enrollmentSources.rules, { bytes: 0, id: 4, mode: null }],
    };

    await expect(plan(fake, 'rules', token)).rejects.toThrow(rulesWithLegacy);
  });

  test('plans rules and enrollments under an enrollments claim only', async () => {
    const fake = new FakeCoordination();
    fake.enrollmentSources = { rules: [], users: [] };
    const history = await runAction(
      { action: 'claim', domain: 'history_index', retry: false },
      context(fake),
    );
    const token = z.object({ token: z.string() }).parse(history).token;

    await expect(plan(fake, 'rules', token)).rejects.toThrow(rulesUnderHistory);
    await expect(plan(fake, 'history', token)).resolves.toMatchObject({
      source: 'history',
      total: 0,
    });
  });
});

const word = /^[a-z][a-z_]*$/u;
const unknownManual =
  /^Rule 4 has the mode "manual"; every enrollment rule must be mapped_entries or legacy_regex, so nothing was planned\.$/u;
const retiredLegacy =
  /^Rule 2 has the mode "legacy_regex"; every enrollment rule must be mapped_entries, so nothing was planned\.$/u;

// A mode only a test registry declares: plain rule ranges, its own page
// kind and runner Flow.
const tallyMode: RuleModeSpec = {
  description: 'counts a synthetic tally',
  label: 'Synthetic tally',
  mode: 'synthetic_tally',
  pageKinds: ['tally'],
  planner: 'rule_ranges',
  runnerFlowId: '6a1d9f0e-2b3c-4d5e-8f70-0000000011ff',
  usesPattern: false,
};

const withoutLegacy = ruleModes.filter(({ mode }) => mode !== 'legacy_regex');

const oversizedUser = /Moodle user 17 holds 800001 bytes/u;

// The registered Flow families holding a template of this id.
const familiesHolding = (id: string) =>
  flowFamilies.filter(({ templates }) =>
    templates.some((template) => template.id === id),
  );

// A family as kind, runner and "token:kind" of each page.
const familyShape = ({ kind, pages, runnerFlowId }: EnrollmentFamily) => [
  kind,
  runnerFlowId,
  pages.map((page) => `${page.token}:${page.kind}`),
];

describe('the rule-mode registry', () => {
  test('declares each mode, page kind and runner once, in plain lowercase words', () => {
    const kinds = ruleModes.flatMap(({ pageKinds }) => [...pageKinds]);

    expect(ruleModeNames()).toEqual(['mapped_entries', 'legacy_regex']);
    expect(new Set(ruleModeNames()).size).toBe(ruleModes.length);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(new Set(runnerFlowIds()).size).toBe(ruleModes.length);
    expect(
      [...ruleModeNames(), ...kinds].every((value) => word.test(value)),
    ).toBeTruthy();

    for (const spec of ruleModes) {
      expect(rulePlanners).toContain(spec.planner);
      expect(spec.pageKinds).toHaveLength(
        spec.planner === 'rule_ranges' ? 1 : 2,
      );
      expect(spec.label.length).toBeGreaterThan(0);
      expect(ruleMode(spec.mode)).toBe(spec);
    }

    expect(alternatives(['a', 'b', 'c'])).toBe('a, b, or c');
  });

  // A `rules` plan carries no page kind, and the one page Flow that counts
  // it reads the rules of its own family's mode only: a second mode
  // planned as rule ranges must not widen what a `rules` plan accepts.
  test('takes a rules plan for the one mode the page Flow of that plan counts', () => {
    expect(rulesPlanMode.mode).toBe('mapped_entries');
    expect(rulesPlanMode.planner).toBe('rule_ranges');
    expect(ruleMode(rulesPlanMode.mode)).toBe(rulesPlanMode);
    expect(rulePageQuery.filter.mode._eq).toBe(rulesPlanMode.mode);
  });

  test('names as each runner an operation-triggered Flow of one registered family', () => {
    for (const { runnerFlowId } of ruleModes) {
      const owners = familiesHolding(runnerFlowId);

      expect(owners).toHaveLength(1);
      expect(
        owners[0]?.templates.find(({ id }) => id === runnerFlowId)?.trigger,
      ).toBe('operation');
      expect(runnerFlowId.slice(-4, -2)).toBe(owners[0]?.code);
    }

    expect(ruleMode('mapped_entries').runnerFlowId).toBe(
      mappedEnrollmentFlowIds.pages,
    );
    expect(ruleMode('legacy_regex').runnerFlowId).toBe(
      legacyEnrollmentFlowIds.parent,
    );
  });

  test('feeds the model enum, its labels and the field notes', () => {
    const rules = operationsCollections.find(
      ({ collection }) => collection === 'course_enrollment_rules',
    );
    const field = (name: string) =>
      rules?.fields.find((candidate) => candidate.field === name);

    expect(modeChoices).toEqual(
      ruleModes.map(({ label, mode }) => ({ label, value: mode })),
    );
    expect(field('mode')).toMatchObject({
      choices: modeChoices,
      kind: 'enum',
      note: 'mapped_entries counts explicit mappings; legacy_regex applies the retained pattern.',
    });
    expect(field('pattern')).toMatchObject({
      note: 'Literal regular expression retained from the checkpoint; only used by legacy_regex.',
    });
  });
});

describe('the enrollments planner over a registry', () => {
  test('plans one family per declared mode that has rules, in declaration order, with its runner', () => {
    const families = planEnrollmentFamilies({
      rules: [
        { bytes: 7, id: 2, mode: 'legacy_regex' },
        { bytes: 0, id: 1, mode: 'mapped_entries' },
      ],
      users: [{ bytes: 10, id: 5 }],
    });

    expect(families.map(familyShape)).toEqual([
      ['mapped_entries', mappedEnrollmentFlowIds.pages, ['p0001:mapped']],
      [
        'legacy_regex',
        legacyEnrollmentFlowIds.parent,
        ['p0002:legacy', 'p0003:legacy_zeros'],
      ],
    ]);
    expect(
      planEnrollmentFamilies({
        rules: [{ bytes: 7, id: 2, mode: 'legacy_regex' }],
        users: [],
      }).map(({ kind }) => kind),
    ).toEqual(['legacy_regex']);
    expect(planEnrollmentFamilies({ rules: [], users: [] })).toEqual([]);
  });

  test('plans a mode a test registry adds, with no planner change', () => {
    const families = planEnrollmentFamilies(
      {
        rules: [
          { bytes: 0, id: 1, mode: 'mapped_entries' },
          { bytes: 0, id: 7, mode: 'synthetic_tally' },
          { bytes: 0, id: 8, mode: 'synthetic_tally' },
        ],
        users: [],
      },
      enrollmentLimits,
      [...ruleModes, tallyMode],
    );

    expect(families.at(-1)).toEqual({
      kind: 'synthetic_tally',
      pages: [{ from: 7, kind: 'tally', rows: 2, to: 8, token: 'p0002' }],
      runnerFlowId: tallyMode.runnerFlowId,
    });
  });

  test('refuses a rule of a mode no registry declares, or one a test registry retired', () => {
    expect(() =>
      planEnrollmentFamilies({
        rules: [{ bytes: 0, id: 4, mode: 'manual' }],
        users: [],
      }),
    ).toThrow(unknownManual);
    expect(() =>
      planEnrollmentFamilies(
        {
          rules: [
            { bytes: 0, id: 1, mode: 'mapped_entries' },
            { bytes: 7, id: 2, mode: 'legacy_regex' },
          ],
          users: [],
        },
        enrollmentLimits,
        withoutLegacy,
      ),
    ).toThrow(retiredLegacy);
    expect(
      planEnrollmentFamilies(
        { rules: [{ bytes: 0, id: 1, mode: 'mapped_entries' }], users: [] },
        enrollmentLimits,
        withoutLegacy,
      ).map(({ kind }) => kind),
    ).toEqual(['mapped_entries']);
  });

  // Converting every rule to mapped_entries leaves no crossed family, so
  // no history is sized: a history over the legacy page budget no longer
  // blocks the counts (follow-up 39).
  test('sizes the histories only for a family that crosses them', () => {
    const users = [{ bytes: 800_001, id: 17 }];

    expect(
      planEnrollmentFamilies({
        rules: [{ bytes: 0, id: 1, mode: 'mapped_entries' }],
        users,
      }).map(({ pages }) => pages.length),
    ).toEqual([1]);
    expect(() =>
      planEnrollmentFamilies({
        rules: [{ bytes: 7, id: 2, mode: 'legacy_regex' }],
        users,
      }),
    ).toThrow(oversizedUser);
  });
});
