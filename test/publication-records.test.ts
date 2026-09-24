import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import {
  abandonedPublicationMessage,
  type ActionContext,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/action-support.js';
import { runAction } from '../directus/extensions/directus-extension-data-operations/src/coordination/actions.js';
import { parseCoordinatorInput } from '../directus/extensions/directus-extension-data-operations/src/coordination/options.js';
import { declaredFilenames } from '../directus/extensions/directus-extension-data-operations/src/coordination/outcomes.js';
import {
  type SqlBinding,
  sqlStore,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/sql-port.js';
import {
  finishSql,
  heartbeatSql,
  recordSql,
  releaseSql,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/sql-statements.js';
import {
  claimStaleAfterMs,
  publicationUploadLeaseMs,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/state.js';
import { statusAction } from '../directus/extensions/directus-extension-data-operations/src/coordination/status.js';
import { stateRowOf } from './automatic-processing-helpers.js';
import { FakeCoordination } from './data-coordination-helpers.js';

// The publish loop records each file's outcome as soon as it is known
// (the coordinator's `record`), so a publication that stops before its
// final complete or fail still reports what it uploaded; and a heartbeat
// before an upload leases the claim until that upload can no longer write.

const publication = 'publication';
const owner = 'process-a';
const otherToken = '6c6b4e8e-5c1d-4b3f-9a0e-1f2d3c4b5a69';
const [first = '', second = '', third = ''] = declaredFilenames;

const claimed = z.object({
  claimed: z.literal(true),
  revision: z.number(),
  token: z.string(),
});

const refusal = z.object({ code: z.string(), status: z.number() });

const context = (fake: FakeCoordination): ActionContext => ({
  owner,
  staleAfterMs: claimStaleAfterMs,
  store: fake.store,
});

// A project whose calculations are current and whose publication is
// pending after an edit of a room.
const pendingPublication = (): FakeCoordination => {
  const fake = new FakeCoordination();
  fake.data.calculationFingerprint = 'graph-a';
  fake.data.publicationFingerprint = 'graph-a';
  fake.sourceWrite('rooms');
  return fake;
};

const claim = async (fake: FakeCoordination, domain = publication) =>
  claimed.parse(
    await runAction(
      parseCoordinatorInput({ action: 'claim', domain, retry: true }),
      context(fake),
    ),
  );

// An action as the operation runs it: the options as the Flow renders
// them, parsed first.
const act = (fake: FakeCoordination, options: Record<string, unknown>) =>
  runAction(parseCoordinatorInput(options), context(fake));

// A thunk, since the options are parsed before the action runs.
const refusalOf = async (work: () => Promise<unknown>) => {
  try {
    await work();
  } catch (error) {
    return refusal.parse(error);
  }
  throw new Error('the action was not refused');
};

const everyFileUploaded = Object.fromEntries(
  declaredFilenames.map((filename) => [
    filename,
    { bytes: 3, outcome: 'uploaded' },
  ]),
);

// A publication completed at the current revision, then a room edit: the
// recorded outcomes are an earlier run's.
const publishedThenEdited = async (): Promise<FakeCoordination> => {
  const fake = pendingPublication();
  const { token } = await claim(fake);
  await act(fake, { action: 'complete', files: everyFileUploaded, token });
  fake.sourceWrite('rooms');
  return fake;
};

describe('record of one published file', () => {
  test('keeps each outcome at the claimed revision as soon as it is known, in publication order', async () => {
    const fake = await publishedThenEdited();
    const earlier = fake.data.completedRevision;
    const { revision, token } = await claim(fake);

    await expect(
      act(fake, {
        action: 'record',
        bytes: '12',
        code: null,
        filename: second,
        outcome: 'uploaded',
        token,
      }),
    ).resolves.toEqual({ filename: second, outcome: 'uploaded', revision });

    // A step that answered no bounded code is recorded as PUBLISH_FAILED.
    await act(fake, {
      action: 'record',
      bytes: 'undefined',
      code: 'Service "files" is unavailable',
      filename: first,
      outcome: 'failed',
      token,
    });

    expect(Object.keys(fake.data.publicationOutcomes ?? {})).toEqual([
      ...declaredFilenames,
    ]);
    expect(fake.data.publicationOutcomes?.[first]).toEqual({
      bytes: null,
      code: 'PUBLISH_FAILED',
      outcome: 'failed',
      revision,
    });
    expect(fake.data.publicationOutcomes?.[second]).toEqual({
      bytes: 12,
      code: null,
      outcome: 'uploaded',
      revision,
    });
    // A file this run has not reached yet keeps the earlier run's entry,
    // which names its own revision.
    expect(fake.data.publicationOutcomes?.[third]).toMatchObject({
      outcome: 'uploaded',
      revision: earlier,
    });
    expect(earlier).toBeLessThan(revision);
    expect(fake.data.publicationState).toBe('running');
    expect(fake.data.claim?.token).toBe(token);
  });

  test('refuses an undeclared file, a calculation claim, a foreign token and an uploaded file with a code', async () => {
    const fake = pendingPublication();
    const { token } = await claim(fake);
    const before = structuredClone(fake.data.publicationOutcomes);

    await expect(
      refusalOf(() =>
        act(fake, {
          action: 'record',
          filename: 'extra.json',
          outcome: 'uploaded',
          token,
        }),
      ),
    ).resolves.toEqual({ code: 'COORDINATION_UNKNOWN_FILE', status: 400 });
    await expect(
      refusalOf(() =>
        act(fake, {
          action: 'record',
          filename: first,
          outcome: 'uploaded',
          token: otherToken,
        }),
      ),
    ).resolves.toEqual({ code: 'COORDINATION_CLAIM_MISMATCH', status: 409 });
    await expect(
      refusalOf(() =>
        act(fake, {
          action: 'record',
          code: 'PUBLISH_UPLOAD_FAILED',
          filename: first,
          outcome: 'uploaded',
          token,
        }),
      ),
    ).resolves.toEqual({ code: 'COORDINATION_INVALID_OPTIONS', status: 400 });
    expect(fake.data.publicationOutcomes).toEqual(before);

    const calculation = new FakeCoordination();
    calculation.sourceWrite('moodle_users');
    const history = await claim(calculation, 'history_index');

    await expect(
      refusalOf(() =>
        runAction(
          parseCoordinatorInput({
            action: 'record',
            filename: first,
            outcome: 'uploaded',
            token: history.token,
          }),
          context(calculation),
        ),
      ),
    ).resolves.toEqual({ code: 'COORDINATION_DOMAIN_MISMATCH', status: 400 });
    expect(calculation.data.publicationOutcomes).toBeNull();
  });

  test('is kept after a source change: an upload cannot be taken back', async () => {
    const fake = pendingPublication();
    const { revision, token } = await claim(fake);
    fake.sourceWrite('staff');

    await act(fake, {
      action: 'record',
      bytes: 7,
      filename: first,
      outcome: 'uploaded',
      token,
    });

    expect(fake.data.publicationOutcomes?.[first]).toMatchObject({
      outcome: 'uploaded',
      revision,
    });
  });
});

describe('a publication that stops before its end', () => {
  test('fails as partial with the files its loop recorded', async () => {
    const fake = await publishedThenEdited();
    const { revision, token } = await claim(fake);
    await act(fake, {
      action: 'record',
      bytes: 4,
      filename: first,
      outcome: 'uploaded',
      token,
    });
    await act(fake, {
      action: 'record',
      code: 'PUBLISH_UPLOAD_FAILED',
      filename: second,
      outcome: 'failed',
      token,
    });

    await expect(
      act(fake, { action: 'fail', code: 'PUBLISH_LOOP_FAILED', token }),
    ).resolves.toMatchObject({ publication: 'partial', revision });
    expect(fake.data.publicationState).toBe('partial');
    expect(fake.data.publicationOutcomes?.[first]).toMatchObject({
      outcome: 'uploaded',
      revision,
    });
    expect(fake.data.publicationOutcomes?.[second]).toMatchObject({
      code: 'PUBLISH_UPLOAD_FAILED',
      outcome: 'failed',
      revision,
    });
    expect(fake.data.dirtyDomains).toEqual([publication]);
  });

  test('fails as failed when nothing was uploaded at its revision, whatever an earlier run uploaded', async () => {
    const fake = await publishedThenEdited();
    const recorded = structuredClone(fake.data.publicationOutcomes);
    const { token } = await claim(fake);

    await expect(
      act(fake, { action: 'fail', code: 'OUTCOMES_REFUSED', token }),
    ).resolves.toMatchObject({ publication: 'failed' });
    expect(fake.data.publicationState).toBe('failed');
    expect(fake.data.publicationOutcomes).toEqual(recorded);
  });

  test('is released by recovery with the files it recorded, and says what it cannot know', async () => {
    const fake = pendingPublication();
    const { revision, token } = await claim(fake);
    await act(fake, { action: 'heartbeat', token });
    await act(fake, {
      action: 'record',
      bytes: 5,
      filename: first,
      outcome: 'uploaded',
      token,
    });
    // The record ended the upload lease: the stale window alone applies.
    fake.advance(claimStaleAfterMs + 1);

    await act(fake, { action: 'claim', domain: 'next_calculation' });

    expect(fake.data.claim).toBeNull();
    expect(fake.data.publicationState).toBe('partial');
    expect(fake.data.lastError).toMatchObject({
      code: 'CLAIM_ABANDONED',
      domain: publication,
      message: abandonedPublicationMessage,
      revision,
    });
    expect(fake.data.publicationOutcomes?.[first]).toMatchObject({
      outcome: 'uploaded',
      revision,
    });
  });
});

describe('the upload lease', () => {
  test('keeps a publication claim whose upload may still write from being recovered', async () => {
    const fake = pendingPublication();
    const { token } = await claim(fake);
    await act(fake, { action: 'heartbeat', token });
    fake.advance(claimStaleAfterMs + 1);

    await expect(
      act(fake, { action: 'claim', domain: 'next_calculation' }),
    ).resolves.toMatchObject({ claimed: false, reason: 'busy' });

    const report = await statusAction(context(fake));

    expect(report.claim?.stale).toBeFalsy();
    expect(report.claim?.heartbeatAgeMs).toBeLessThan(0);

    fake.advance(publicationUploadLeaseMs);
    await act(fake, { action: 'claim', domain: 'next_calculation' });

    expect(fake.data.claim).toBeNull();
    expect(fake.data.lastError?.code).toBe('CLAIM_ABANDONED');
    expect(fake.data.publicationState).toBe('failed');
  });

  test('leaves a calculation heartbeat unleased', async () => {
    const fake = new FakeCoordination();
    fake.sourceWrite('moodle_users');
    const { token } = await claim(fake, 'history_index');
    await act(fake, { action: 'heartbeat', token });
    fake.advance(claimStaleAfterMs + 1);

    await act(fake, { action: 'claim', domain: 'next_calculation' });

    expect(fake.data.lastError?.code).toBe('CLAIM_INTERRUPTED');
    expect(fake.data.claim?.token).not.toBe(token);
  });

  test('outlasts the storage driver: three S3 calls of three attempts each', () => {
    const attemptMs = 5_000 + 120_000;

    expect(publicationUploadLeaseMs).toBeGreaterThan(3 * 3 * attemptMs);
  });
});

// One stored outcome of a file.
const entry = (outcome: 'failed' | 'uploaded', revision: number) => ({
  bytes: null,
  code: outcome === 'uploaded' ? null : 'X',
  outcome,
  revision,
});

describe('the SQL port', () => {
  const token = otherToken;

  // A database holding one publication claim at revision 9 and the
  // outcomes given; every statement and its bindings are kept.
  const database = (outcomes: unknown) => {
    const sent: Array<{ bindings: SqlBinding[]; sql: string }> = [];
    const row = stateRowOf({
      claim_domain: publication,
      claim_owner: owner,
      claim_revision: 9,
      claim_token: token,
      publication_outcomes: z
        .record(
          z.string(),
          z.object({
            bytes: z.number().nullable(),
            code: z.string().nullable(),
            outcome: z.enum(['uploaded', 'failed', 'skipped']),
            revision: z.number(),
          }),
        )
        .parse(outcomes),
      publication_state: 'running',
    });
    const raw = async (sql: string, bindings: SqlBinding[] = []) => {
      sent.push({ bindings, sql });
      return sql.startsWith('SELECT')
        ? { rowCount: 1, rows: [row] }
        : { rowCount: 1, rows: [] };
    };
    return {
      sent,
      store: sqlStore({ raw, transaction: (work) => work({ raw }) }),
    };
  };

  const releasedState = async (outcomes: unknown) => {
    const { sent, store } = database(outcomes);
    await store.transaction((port) =>
      port.release({ code: 'CLAIM_ABANDONED', failed: true, token }),
    );
    const release = sent.find(({ sql }) => sql === releaseSql);
    // Bindings: code, message, publication state, outcomes JSON, token.
    return release?.bindings.slice(2, 4);
  };

  test('releases a publication without a map by the outcomes its loop recorded at the claimed revision', async () => {
    await expect(
      releasedState({ [first]: entry('uploaded', 9) }),
    ).resolves.toEqual(['partial', null]);
    await expect(
      releasedState({
        [first]: entry('uploaded', 8),
        [second]: entry('failed', 9),
      }),
    ).resolves.toEqual(['failed', null]);
    await expect(releasedState({})).resolves.toEqual(['failed', null]);
  });

  test('leases a heartbeat, records one file and finishes a superseded publication only', async () => {
    const { sent, store } = database({});
    await store.transaction(async (port) => {
      await port.heartbeat(token, owner, publicationUploadLeaseMs);
      await port.heartbeat(token, owner);
      await port.recordOutcomes(token, owner, {
        [first]: entry('uploaded', 9),
      });
      await port.finish({
        claimRevision: 9,
        dirtyDomains: [publication],
        files: null,
        fingerprint: 'graph-a',
        owner,
        superseded: true,
        token,
      });
    });

    expect(sent.map(({ bindings, sql }) => [sql, bindings])).toEqual([
      [heartbeatSql, [publicationUploadLeaseMs, token, owner]],
      [heartbeatSql, [0, token, owner]],
      [
        recordSql,
        [JSON.stringify({ [first]: entry('uploaded', 9) }), token, owner],
      ],
      [finishSql, ['["publication"]', null, token, owner, 9, true, 'graph-a']],
    ]);
    expect(heartbeatSql).toContain(
      `"claim_heartbeat_at" = clock_timestamp() + ?::integer * interval '1 millisecond'`,
    );
    expect(recordSql).toContain(`AND "claim_domain" = 'publication'`);
    // A record refreshes the heartbeat, which ends the upload lease.
    expect(recordSql).toContain(
      `SET "publication_outcomes" = ?::json, "claim_heartbeat_at" = clock_timestamp()`,
    );
    // Only a publication may finish after a source change, and only when
    // the caller says it was superseded.
    expect(finishSql).toContain(
      `OR (?::boolean AND "claim_domain" = 'publication')) AND "claim_fingerprint" = ?`,
    );
  });
});
