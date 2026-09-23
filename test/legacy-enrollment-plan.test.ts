import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { runAction } from '../directus/extensions/directus-extension-data-operations/src/coordination/actions.js';
import { installSql } from '../directus/extensions/directus-extension-data-operations/src/coordination/sql-statements.js';
import { FakeCoordination } from './data-coordination-helpers.js';
import { claimEnrollments, context } from './legacy-enrollment-helpers.js';

// plan_pages over the persistence port for enrollments claims: the one
// plan of both rule families (source enrollments), its completion, and
// the pairing of every table source with its own claim domain. The pure
// planner and the page scripts are in legacy-enrollment-flow.test.ts.

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
      pages: [
        { from: 1, kind: 'mapped', rows: 1, to: 1, token: 'p0001' },
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
      source: 'enrollments',
      total: 3,
    });

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
  /^plan_pages with source rules plans mapped_entries rules only, and rule (?:2|4) has another mode; plan with source enrollments, which covers the legacy family too\. Nothing was planned\.$/u;
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
