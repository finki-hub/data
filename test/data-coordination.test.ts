import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { ActionContext } from '../directus/extensions/directus-extension-data-operations/src/coordination/action-support.js';

import {
  recoverAction,
  runAction,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/actions.js';
import {
  abandonedClaim,
  decideClaim,
  decideCompletion,
  decideStage,
  pendingDomains,
  verifyClaim,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/decisions.js';
import { type Domain } from '../directus/extensions/directus-extension-data-operations/src/coordination/domains.js';
import {
  abandonedCode,
  interruptedCode,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/failures.js';
import { declaredFilenames } from '../directus/extensions/directus-extension-data-operations/src/coordination/outcomes.js';
import {
  claimStaleAfterMs,
  type OperationsState,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/state.js';
import { statusAction } from '../directus/extensions/directus-extension-data-operations/src/coordination/status.js';
import { bothGraphs, FakeCoordination } from './data-coordination-helpers.js';

const uuid = '6c6b4e8e-5c1d-4b3f-9a0e-1f2d3c4b5a69';
const otherUuid = '0f8a1d2c-3b4e-4f5a-8b6c-7d8e9f0a1b2c';
const history = 'history_index';
const enrollments = 'enrollments';
const publication = 'publication';
const graphA = 'graph-a';
const graphB = 'graph-b';
const [graphsA, graphsB] = [bothGraphs(graphA), bothGraphs(graphB)];
const processA = 'process-a';
const processB = 'process-b';
const oldProcess = 'process-old';
const newProcess = 'process-new';
const claimMismatch = 'COORDINATION_CLAIM_MISMATCH';
const pagesMissing = 'COORDINATION_PAGES_MISSING';
const pageUnplanned = 'COORDINATION_PAGE_UNPLANNED';
const firstPage = 'p0001';
const secondPage = 'p0002';

type ClaimOptions = { readonly owner?: string; readonly retry?: boolean };

const claimed = z.object({
  claimed: z.literal(true),
  domains: z.array(z.string()),
  owner: z.string(),
  revision: z.number(),
  token: z.string(),
});
const refused = z.object({ claimed: z.literal(false), reason: z.string() });
const planned = z.object({
  pages: z.array(
    z.object({
      from: z.number(),
      rows: z.number(),
      to: z.number(),
      token: z.string(),
    }),
  ),
  total: z.number(),
});

const context = (fake: FakeCoordination, owner = processA): ActionContext => ({
  owner,
  staleAfterMs: claimStaleAfterMs,
  store: fake.store,
});

const claim = (
  fake: FakeCoordination,
  domain: Domain,
  options: ClaimOptions = {},
) =>
  runAction(
    { action: 'claim', domain, retry: options.retry ?? false },
    context(fake, options.owner),
  );

const claimToken = async (
  fake: FakeCoordination,
  domain: Domain,
  options: ClaimOptions = {},
): Promise<string> => claimed.parse(await claim(fake, domain, options)).token;

const complete = (fake: FakeCoordination, token: string, owner?: string) =>
  runAction({ action: 'complete', token }, context(fake, owner));

type StageInput = {
  readonly owner?: string;
  readonly page: string;
  readonly rows: Array<{
    academic_year: number;
    count: number;
    course: number;
  }>;
  readonly token: string;
};

const stage = (fake: FakeCoordination, input: StageInput) =>
  runAction(
    {
      action: 'stage_page',
      page: input.page,
      rows: input.rows,
      token: input.token,
    },
    context(fake, input.owner),
  );

const planHistory = (fake: FakeCoordination, token: string, owner?: string) =>
  runAction(
    { action: 'plan_pages', source: 'history', token },
    context(fake, owner),
  );

// Finishes the history index so the enrollment domain becomes claimable:
// plans the Moodle users of the fake, indexes every page with empty
// histories and completes.
const settleHistory = async (fake: FakeCoordination): Promise<void> => {
  const token = await claimToken(fake, history);
  const plan = planned.parse(await planHistory(fake, token));
  for (const page of plan.pages) {
    const rows = fake.sourceIds.history
      .filter((id) => id >= page.from && id <= page.to)
      .map((id) => ({ entries: [], id }));
    await runAction(
      { action: 'index_page', page: page.token, rows, token },
      context(fake),
    );
  }
  await complete(fake, token);
};

const failureOf = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
    return null;
  } catch (error) {
    return error;
  }
};

const baseState = (
  overrides: Partial<OperationsState> = {},
): OperationsState => ({
  calculationFingerprint: graphA,
  claim: null,
  completedRevision: 3,
  dirtyDomains: [],
  finishedAt: null,
  importState: 'idle',
  inputRevisions: { enrollments: 3, history_index: 3 },
  lastError: null,
  publicationFingerprint: graphA,
  publicationOutcomes: null,
  publicationState: 'idle',
  requestedRevision: 3,
  sourceRevision: 3,
  startedAt: null,
  ...overrides,
});

const liveClaim = (
  overrides: Partial<NonNullable<OperationsState['claim']>> = {},
): NonNullable<OperationsState['claim']> => ({
  domain: enrollments,
  fingerprint: graphA,
  heartbeatAgeMs: 100,
  heartbeatAt: 't+1',
  owner: processA,
  pages: [firstPage, secondPage],
  ranges: [],
  revision: 3,
  staged: [firstPage, secondPage],
  startedAt: 't+0',
  token: uuid,
  ...overrides,
});

describe('claim decisions', () => {
  test('marks every domain pending until a graph fingerprint matches', () => {
    expect(
      pendingDomains(
        baseState({
          calculationFingerprint: null,
          publicationFingerprint: null,
        }),
        graphsA,
      ),
    ).toEqual([history, enrollments, publication]);
    expect(pendingDomains(baseState(), graphsA)).toEqual([]);
    expect(pendingDomains(baseState(), graphsB)).toEqual([
      history,
      enrollments,
      publication,
    ]);
    expect(
      pendingDomains(baseState({ dirtyDomains: [publication] }), graphsA),
    ).toEqual([publication]);
    expect(
      pendingDomains(
        baseState({ publicationFingerprint: 'graph-old' }),
        graphsA,
      ),
    ).toEqual([publication]);
  });

  test('claims one job only, in dependency order, and blocks a failed revision until retried', () => {
    const request = {
      currentFingerprints: graphsA,
      domain: publication,
      retry: false,
    } as const;

    expect(
      decideClaim(
        baseState({ claim: liveClaim(), dirtyDomains: [publication] }),
        request,
      ).kind,
    ).toBe('busy');
    expect(
      decideClaim(baseState(), { ...request, domain: enrollments }),
    ).toEqual({ kind: 'nothing_pending' });
    expect(
      decideClaim(baseState({ dirtyDomains: [history, publication] }), request),
    ).toEqual({ blocking: [history], kind: 'upstream_dirty' });
    expect(
      decideClaim(baseState({ dirtyDomains: [enrollments] }), {
        ...request,
        currentFingerprints: graphsB,
        domain: enrollments,
      }),
    ).toEqual({ blocking: [history], kind: 'upstream_dirty' });
    expect(
      decideClaim(baseState({ dirtyDomains: [enrollments] }), {
        ...request,
        domain: enrollments,
      }),
    ).toEqual({
      dirtyDomains: [enrollments],
      domain: enrollments,
      kind: 'claim',
    });

    const failed = baseState({
      dirtyDomains: [publication],
      lastError: {
        at: 't+9',
        code: 'PUBLISH_FAILED',
        domain: publication,
        fingerprint: graphA,
        message: null,
        revision: 3,
      },
    });

    expect(decideClaim(failed, request).kind).toBe('failed');

    for (const code of ['SOURCE_CHANGED', 'FINGERPRINT_CHANGED']) {
      const overtaken = baseState({
        dirtyDomains: [publication],
        lastError: {
          at: 't+9',
          code,
          domain: publication,
          fingerprint: graphA,
          message: null,
          revision: 3,
        },
      });

      expect(decideClaim(overtaken, request).kind).toBe('claim');
    }

    expect(decideClaim(failed, { ...request, retry: true }).kind).toBe('claim');
    expect(decideClaim({ ...failed, sourceRevision: 4 }, request).kind).toBe(
      'claim',
    );
    expect(
      decideClaim(failed, { ...request, currentFingerprints: graphsB }),
    ).toEqual({ blocking: [history, enrollments], kind: 'upstream_dirty' });
    expect(
      decideClaim(baseState(), {
        ...request,
        currentFingerprints: graphsB,
        domain: history,
      }),
    ).toEqual({
      dirtyDomains: [history, enrollments, publication],
      domain: history,
      kind: 'claim',
    });
  });

  test('treats a claim as abandoned only once its heartbeat is older than the window', () => {
    expect(claimStaleAfterMs).toBe(60_000);
    expect(
      abandonedClaim(
        baseState({ claim: liveClaim({ heartbeatAgeMs: 59_999 }) }),
        claimStaleAfterMs,
      ),
    ).toBeNull();
    expect(
      abandonedClaim(
        baseState({ claim: liveClaim({ heartbeatAgeMs: 60_001 }) }),
        claimStaleAfterMs,
      )?.token,
    ).toBe(uuid);
    expect(abandonedClaim(baseState(), claimStaleAfterMs)).toBeNull();
  });
});

describe('page and completion decisions', () => {
  test('verifies token, owner and source revision before any page', () => {
    const state = baseState({ claim: liveClaim() });
    const check = { owner: processA, token: uuid };

    expect(verifyClaim(state, check)).toBe('ok');
    expect(verifyClaim(state, { ...check, token: otherUuid })).toBe(
      'claim_mismatch',
    );
    expect(verifyClaim(state, { ...check, owner: processB })).toBe(
      'owner_mismatch',
    );
    expect(
      verifyClaim(
        {
          ...state,
          inputRevisions: { enrollments: 4, history_index: 3 },
          sourceRevision: 4,
        },
        check,
      ),
    ).toBe('source_changed');
    expect(verifyClaim(baseState(), check)).toBe('claim_mismatch');
    expect(decideStage(state, { ...check, page: secondPage })).toEqual({
      kind: 'ok',
    });
    expect(decideStage(state, { ...check, page: 'p0003' })).toEqual({
      kind: 'page_unplanned',
    });
    expect(
      decideStage(baseState({ claim: liveClaim({ pages: null }) }), {
        ...check,
        page: firstPage,
      }),
    ).toEqual({ kind: 'page_unplanned' });
  });

  test('accepts output only at the claimed revision and fingerprint with every planned page staged', () => {
    const check = { currentFingerprint: graphA, owner: processA, token: uuid };

    expect(decideCompletion(baseState({ claim: liveClaim() }), check)).toEqual({
      kind: 'ok',
    });
    expect(
      decideCompletion(baseState({ claim: liveClaim() }), {
        ...check,
        currentFingerprint: graphB,
      }),
    ).toEqual({ kind: 'fingerprint_changed' });
    expect(
      decideCompletion(
        baseState({
          claim: liveClaim(),
          inputRevisions: { enrollments: 4, history_index: 3 },
          sourceRevision: 4,
        }),
        check,
      ),
    ).toEqual({ kind: 'source_changed' });
    expect(
      decideCompletion(
        baseState({ claim: liveClaim({ staged: [firstPage] }) }),
        check,
      ),
    ).toEqual({ kind: 'pages_missing', missing: [secondPage] });
    expect(
      decideCompletion(
        baseState({ claim: liveClaim({ pages: null, staged: [] }) }),
        check,
      ),
    ).toEqual({ kind: 'unplanned' });
    expect(
      decideCompletion(
        baseState({
          claim: liveClaim({ domain: history, pages: null, staged: [] }),
        }),
        check,
      ),
    ).toEqual({ kind: 'unplanned' });
    expect(
      decideCompletion(
        baseState({
          claim: liveClaim({ domain: history, pages: [], staged: [] }),
        }),
        check,
      ),
    ).toEqual({ kind: 'ok' });
    expect(
      decideCompletion(baseState({ claim: liveClaim() }), {
        ...check,
        token: otherUuid,
      }),
    ).toEqual({ kind: 'claim_mismatch' });
    expect(
      decideCompletion(baseState({ claim: liveClaim() }), {
        ...check,
        owner: processB,
      }),
    ).toEqual({ kind: 'owner_mismatch' });
  });
});

describe('claims over the persistence port', () => {
  test('lets exactly one of twenty simultaneous claims through', async () => {
    const fake = new FakeCoordination();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => claim(fake, history)),
    );
    const winners = results.filter(
      (result) => claimed.safeParse(result).success,
    );
    const losers = results
      .filter((result) => refused.safeParse(result).success)
      .map((result) => refused.parse(result).reason);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(19);
    expect(new Set(losers)).toEqual(new Set(['busy']));
    expect(fake.data.claim?.token).toBe(claimed.parse(winners[0]).token);
    expect(fake.transactions).toBe(20);
  });

  test('keeps a source change during a run pending and refuses the completion', async () => {
    const fake = new FakeCoordination();
    await settleHistory(fake);
    fake.sourceWrite('academic_years');
    const token = await claimToken(fake, enrollments);
    const revision = fake.data.sourceRevision;
    fake.sourceWrite('course_enrollment_rules');
    const failure = await failureOf(complete(fake, token));

    expect(failure).toMatchObject({
      code: 'COORDINATION_SOURCE_CHANGED',
      status: 409,
    });
    expect(fake.data.claim).toBeNull();
    expect(fake.data.dirtyDomains).toEqual([enrollments, publication]);
    expect(fake.data.candidates).toEqual([]);
    expect(fake.data.lastError).toMatchObject({
      code: 'SOURCE_CHANGED',
      domain: enrollments,
      revision,
    });
    expect(fake.data.completedRevision).not.toBe(fake.data.sourceRevision);

    const again = claimed.parse(await claim(fake, enrollments));

    expect(again.revision).toBe(revision + 1);
    expect(again.token).not.toBe(token);
  });

  test('rejects a late completion with a wrong token or from another process and keeps the claim', async () => {
    const fake = new FakeCoordination();
    const token = await claimToken(fake, history);

    await expect(complete(fake, otherUuid)).rejects.toMatchObject({
      code: claimMismatch,
      status: 409,
    });
    await expect(complete(fake, token, processB)).rejects.toMatchObject({
      code: 'COORDINATION_OWNER_MISMATCH',
    });
    await expect(
      runAction({ action: 'heartbeat', token: otherUuid }, context(fake)),
    ).rejects.toMatchObject({ code: claimMismatch });
    expect(fake.data.claim?.token).toBe(token);
    await expect(
      runAction(
        { action: 'fail', code: 'X', message: null, token: otherUuid },
        context(fake),
      ),
    ).resolves.toEqual({ failed: false, reason: 'claim_mismatch' });
    expect(fake.data.claim?.token).toBe(token);
    await expect(complete(fake, token)).rejects.toMatchObject({
      code: pagesMissing,
      status: 409,
    });
    expect(fake.data.claim?.token).toBe(token);

    await planHistory(fake, token);

    await expect(complete(fake, token)).resolves.toMatchObject({
      completed: true,
      domain: history,
    });
    expect(fake.data.calculationFingerprint).toBe(graphA);
  });

  test('discards output when the flow graph changed mid-run and marks the domains again', async () => {
    const fake = new FakeCoordination();
    await settleHistory(fake);
    fake.sourceWrite('academic_years');
    const token = await claimToken(fake, enrollments);
    fake.graphs = graphsB;

    await expect(complete(fake, token)).rejects.toMatchObject({
      code: 'COORDINATION_FINGERPRINT_CHANGED',
    });
    expect(fake.data.claim).toBeNull();
    expect(fake.data.lastError).toMatchObject({
      code: 'FINGERPRINT_CHANGED',
      fingerprint: graphA,
    });

    const next = claimed.parse(await claim(fake, history));

    expect(next.domains).toEqual([history, enrollments, publication]);
    expect(fake.data.dirtyDomains).toEqual([history, enrollments, publication]);
  });
});

describe('pages over the persistence port', () => {
  test('replaces a retried page instead of double counting and refuses unplanned pages', async () => {
    const fake = new FakeCoordination();
    fake.sourceIds.rules = [11, 12, 13];
    await settleHistory(fake);
    fake.sourceWrite('course_enrollment_rules');
    const token = await claimToken(fake, enrollments);
    const rows = [
      { academic_year: 1, count: 2, course: 1 },
      { academic_year: 1, count: 5, course: 2 },
    ];

    await expect(
      stage(fake, { page: firstPage, rows, token }),
    ).rejects.toMatchObject({
      code: pageUnplanned,
    });

    const plan = planned.parse(
      await runAction(
        { action: 'plan_pages', source: 'rules', token },
        context(fake),
      ),
    );

    expect(plan).toEqual({
      pages: [{ from: 11, rows: 3, to: 13, token: firstPage }],
      total: 1,
    });
    await expect(
      stage(fake, { page: firstPage, rows, token }),
    ).resolves.toEqual({
      page: firstPage,
      replaced: 0,
      staged: 2,
    });
    await expect(
      stage(fake, { page: firstPage, rows, token }),
    ).resolves.toEqual({
      page: firstPage,
      replaced: 2,
      staged: 2,
    });
    expect(fake.data.candidates).toHaveLength(2);
    expect(fake.data.claim?.staged).toEqual([firstPage]);
    await expect(
      stage(fake, { page: secondPage, rows, token }),
    ).rejects.toMatchObject({
      code: pageUnplanned,
    });
    await expect(
      stage(fake, {
        page: firstPage,
        rows: [...rows, { academic_year: 1, count: 1, course: 1 }],
        token,
      }),
    ).rejects.toMatchObject({
      code: 'COORDINATION_DUPLICATE_ROWS',
      status: 400,
    });
    expect(fake.data.candidates).toHaveLength(2);
    await expect(
      stage(fake, {
        page: firstPage,
        rows: [{ academic_year: 1, count: 5, course: 2 }],
        token,
      }),
    ).resolves.toEqual({ page: firstPage, replaced: 2, staged: 1 });
    expect(fake.data.candidates.map(({ course }) => course)).toEqual([2]);
  });

  test('never labels a partial batch current and installs aggregated counts atomically', async () => {
    const fake = new FakeCoordination();
    fake.sourceIds.rules = Array.from({ length: 300 }, (_, index) => index + 1);
    fake.data.enrollments.push({
      academic_year: 9,
      count: 99,
      course: 9,
      revision: 0,
    });
    await settleHistory(fake);
    fake.sourceWrite('moodle_course_mappings');
    const token = await claimToken(fake, enrollments);
    const plan = planned.parse(
      await runAction(
        { action: 'plan_pages', source: 'rules', token },
        context(fake),
      ),
    );

    expect(plan.pages.map(({ rows }) => rows)).toEqual([250, 50]);
    await expect(complete(fake, token)).rejects.toMatchObject({
      code: pagesMissing,
      extensions: { missing: [firstPage, secondPage] },
    });

    await stage(fake, {
      page: firstPage,
      rows: [
        { academic_year: 1, count: 2, course: 1 },
        { academic_year: 1, count: 1, course: 2 },
      ],
      token,
    });

    await expect(complete(fake, token)).rejects.toMatchObject({
      code: pagesMissing,
      extensions: { missing: [secondPage] },
    });
    expect(fake.data.claim?.token).toBe(token);
    expect(fake.data.enrollments).toHaveLength(1);

    await stage(fake, {
      page: secondPage,
      rows: [{ academic_year: 1, count: 3, course: 1 }],
      token,
    });
    const revision = fake.data.sourceRevision;

    await expect(complete(fake, token)).resolves.toEqual({
      completed: true,
      domain: enrollments,
      installed: 2,
      revision,
    });
    expect(fake.data.enrollments).toEqual([
      { academic_year: 1, count: 5, course: 1, revision },
      { academic_year: 1, count: 1, course: 2, revision },
    ]);
    expect(fake.data.candidates).toEqual([]);
    expect(fake.data.claim).toBeNull();
    expect(fake.data.dirtyDomains).toEqual([publication]);
    expect(fake.data.completedRevision).toBe(revision);
    expect(fake.data.calculationFingerprint).toBe(graphA);
  });

  test('discards the candidates of a replaced plan so completion installs only the current plan', async () => {
    const fake = new FakeCoordination();
    fake.enrollmentSources = {
      rules: Array.from({ length: 300 }, (_, index) => ({
        bytes: 0,
        id: index + 1,
        mode: 'mapped_entries',
      })),
      users: [],
    };
    fake.sourceIds.rules = [1, 2, 3];
    await settleHistory(fake);
    fake.sourceWrite('moodle_course_mappings');
    const token = await claimToken(fake, enrollments);
    const row = { academic_year: 1, count: 10, course: 1 };
    const first = await runAction(
      { action: 'plan_pages', source: 'enrollments', token },
      context(fake),
    );

    expect(first).toMatchObject({ discarded: 0, total: 2 });
    expect(fake.data.claim?.pages).toEqual([firstPage, secondPage]);

    await stage(fake, { page: firstPage, rows: [row], token });
    await stage(fake, {
      page: secondPage,
      rows: [{ ...row, count: 7 }],
      token,
    });

    expect(fake.data.candidates).toHaveLength(2);

    const second = await runAction(
      { action: 'plan_pages', source: 'rules', token },
      context(fake),
    );

    expect(second).toMatchObject({ discarded: 2, total: 1 });
    expect(fake.data.candidates).toEqual([]);
    expect(fake.data.claim?.pages).toEqual([firstPage]);
    expect(fake.data.claim?.staged).toEqual([]);
    await expect(complete(fake, token)).rejects.toMatchObject({
      code: pagesMissing,
      extensions: { missing: [firstPage] },
    });

    await stage(fake, { page: firstPage, rows: [{ ...row, count: 1 }], token });
    const revision = fake.data.sourceRevision;

    await expect(complete(fake, token)).resolves.toEqual({
      completed: true,
      domain: enrollments,
      installed: 1,
      revision,
    });
    expect(fake.data.enrollments).toEqual([
      { academic_year: 1, count: 1, course: 1, revision },
    ]);
    expect(fake.data.candidates).toEqual([]);
  });
});

describe('lock discipline over the persistence port', () => {
  test('locks the singleton before every write and never for a status read', async () => {
    const fake = new FakeCoordination();
    fake.sourceIds.rules = [1];
    await settleHistory(fake);
    fake.sourceWrite('course_enrollment_rules');
    const token = await claimToken(fake, enrollments);
    const locksOf = async (work: Promise<unknown>): Promise<boolean[]> => {
      fake.readLocks = [];
      await work;
      return fake.readLocks;
    };

    await expect(
      locksOf(
        runAction(
          { action: 'plan_pages', source: 'rules', token },
          context(fake),
        ),
      ),
    ).resolves.toEqual([true]);
    await expect(
      locksOf(
        stage(fake, {
          page: firstPage,
          rows: [{ academic_year: 1, count: 1, course: 1 }],
          token,
        }),
      ),
    ).resolves.toEqual([true]);
    await expect(
      locksOf(runAction({ action: 'heartbeat', token }, context(fake))),
    ).resolves.toEqual([true]);
    await expect(locksOf(statusAction(context(fake)))).resolves.toEqual([
      false,
    ]);
    await expect(locksOf(complete(fake, token))).resolves.toEqual([true]);

    const next = await claimToken(fake, publication);

    await expect(
      locksOf(
        runAction(
          { action: 'fail', code: 'X', message: null, token: next },
          context(fake),
        ),
      ),
    ).resolves.toEqual([true]);
    await expect(
      locksOf(claim(fake, publication, { retry: true })),
    ).resolves.toEqual([true]);
    await expect(locksOf(recoverAction(context(fake)))).resolves.toEqual([
      true,
    ]);
  });
});

describe('failures and recovery over the persistence port', () => {
  test('keeps a failed job failed until an explicit retry or a newer revision', async () => {
    const fake = new FakeCoordination();
    fake.data.calculationFingerprint = graphA;
    fake.sourceWrite('rooms');
    const token = await claimToken(fake, publication);

    expect(fake.data.publicationState).toBe('running');
    await expect(
      runAction(
        { action: 'fail', code: 'PUBLISH_FAILED', message: null, token },
        context(fake),
      ),
    ).resolves.toMatchObject({
      code: 'PUBLISH_FAILED',
      domain: publication,
      failed: true,
    });
    expect(fake.data.publicationState).toBe('failed');
    expect(fake.data.lastError).toMatchObject({
      code: 'PUBLISH_FAILED',
      domain: publication,
      revision: fake.data.sourceRevision,
    });
    expect(fake.data.dirtyDomains).toEqual([publication]);
    await expect(claim(fake, publication)).resolves.toMatchObject({
      claimed: false,
      error: 'PUBLISH_FAILED',
      reason: 'failed',
    });

    const retried = await claimToken(fake, publication, { retry: true });
    const files = Object.fromEntries(
      declaredFilenames.map((name) => [name, { outcome: 'uploaded' as const }]),
    );

    await expect(
      runAction({ action: 'complete', files, token: retried }, context(fake)),
    ).resolves.toMatchObject({ completed: true, domain: publication });
    expect(fake.data.publicationState).toBe('completed');

    expect(Object.keys(fake.data.publicationOutcomes ?? {})).toEqual(
      declaredFilenames,
    );
    expect(fake.data.publicationFingerprint).toBe(graphA);
    expect(fake.data.dirtyDomains).toEqual([]);
    await expect(claim(fake, publication)).resolves.toEqual({
      claimed: false,
      reason: 'nothing_pending',
    });

    fake.sourceWrite('staff');

    await expect(claim(fake, publication)).resolves.toMatchObject({
      claimed: true,
    });
  });

  test('releases an abandoned claim after the window but never a heartbeating one, rerunning a calculation once', async () => {
    const fake = new FakeCoordination();
    const token = await claimToken(fake, history, { owner: oldProcess });
    const revision = fake.data.sourceRevision;
    fake.advance(claimStaleAfterMs - 1);

    await expect(
      claim(fake, history, { owner: newProcess }),
    ).resolves.toMatchObject({
      claimed: false,
      owner: oldProcess,
      reason: 'busy',
    });
    await expect(
      recoverAction(context(fake, newProcess)),
    ).resolves.toMatchObject({
      released: false,
    });

    await runAction({ action: 'heartbeat', token }, context(fake, oldProcess));
    fake.advance(claimStaleAfterMs - 1);

    await expect(
      claim(fake, history, { owner: newProcess }),
    ).resolves.toMatchObject({
      claimed: false,
      reason: 'busy',
    });

    fake.advance(2);

    // The first interruption of a calculation at its inputs (a restart
    // mid-run) is released and the same claim attempt runs it again.
    const rerun = claimed.parse(
      await claim(fake, history, { owner: newProcess }),
    );

    expect(rerun.owner).toBe(newProcess);
    expect(rerun.token).not.toBe(token);
    expect(fake.data.lastError).toMatchObject({
      code: interruptedCode,
      domain: history,
      revision,
    });
    await expect(complete(fake, token, oldProcess)).rejects.toMatchObject({
      code: claimMismatch,
    });

    // A repeat interruption waits for a retry (automatic-processing-revisions).
    await planHistory(fake, rerun.token, newProcess);

    await expect(
      complete(fake, rerun.token, newProcess),
    ).resolves.toMatchObject({
      completed: true,
    });
  });

  test('recovers on startup without erasing failure details', async () => {
    const fake = new FakeCoordination();
    fake.data.calculationFingerprint = graphA;
    fake.sourceWrite('courses');
    const token = await claimToken(fake, publication, { owner: oldProcess });

    // A publication claim plans no table source.
    await expect(
      runAction(
        { action: 'plan_pages', source: 'rules', token },
        context(fake, oldProcess),
      ),
    ).rejects.toMatchObject({ code: 'COORDINATION_DOMAIN_MISMATCH' });

    await failureOf(
      stage(fake, {
        owner: oldProcess,
        page: firstPage,
        rows: [{ academic_year: 1, count: 1, course: 1 }],
        token,
      }),
    );
    fake.advance(claimStaleAfterMs + 1);

    await expect(recoverAction(context(fake, newProcess))).resolves.toEqual({
      owner: newProcess,
      released: true,
      revision: fake.data.sourceRevision,
    });
    expect(fake.data.claim).toBeNull();
    expect(fake.data.candidates).toEqual([]);
    expect(fake.data.dirtyDomains).toEqual([publication]);
    expect(fake.data.publicationState).toBe('failed');
    expect(fake.data.lastError).toMatchObject({
      code: abandonedCode,
      domain: publication,
    });
    await expect(
      claim(fake, publication, { owner: newProcess }),
    ).resolves.toMatchObject({ claimed: false, reason: 'failed' });
    await expect(
      claim(fake, publication, { owner: newProcess, retry: true }),
    ).resolves.toMatchObject({ claimed: true });
  });
});

describe('status over the persistence port', () => {
  test('marks domains atomically and reports a bounded status without the token', async () => {
    const fake = new FakeCoordination();

    await expect(
      runAction(
        { action: 'mark', domains: [publication, publication] },
        context(fake),
      ),
    ).resolves.toEqual({ domains: [publication], revision: 1 });
    await expect(
      runAction({ action: 'mark', domains: [history] }, context(fake)),
    ).resolves.toEqual({ domains: [history, publication], revision: 2 });

    const token = await claimToken(fake, history);
    fake.advance(10);
    const status = await statusAction(context(fake));

    expect(JSON.stringify(status)).not.toContain(token);
    expect(status).toMatchObject({
      candidates: 0,
      claim: {
        domain: history,
        heartbeatAgeMs: 10,
        ownedByThisProcess: true,
        owner: processA,
        pages: null,
        revision: 2,
        staged: 0,
        stale: false,
      },
      dirty: [history, enrollments, publication],
      fingerprints: {
        calculation: null,
        current: graphsA,
        publication: null,
      },
      lastError: null,
      pending: [history, enrollments, publication],
      process: processA,
      publication: { state: 'idle' },
      revisions: { completed: 0, requested: 2, source: 2 },
      staleAfterMs: claimStaleAfterMs,
    });
    await expect(
      runAction({ action: 'status' }, context(fake, processB)),
    ).resolves.toMatchObject({ claim: { ownedByThisProcess: false } });
  });
});
