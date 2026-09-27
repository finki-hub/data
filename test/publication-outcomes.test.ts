import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { ActionContext } from '../directus/extensions/directus-extension-data-operations/src/coordination/action-support.js';

import { runAction } from '../directus/extensions/directus-extension-data-operations/src/coordination/actions.js';
import { parseCoordinatorInput } from '../directus/extensions/directus-extension-data-operations/src/coordination/options.js';
import {
  declaredFilenames,
  releasedPublicationState,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/outcomes.js';
import { claimStaleAfterMs } from '../directus/extensions/directus-extension-data-operations/src/coordination/state.js';
import { statusAction } from '../directus/extensions/directus-extension-data-operations/src/coordination/status.js';
import { bothGraphs, FakeCoordination } from './data-coordination-helpers.js';

const publication = 'publication';
const processA = 'process-a';
const graphA = 'graph-a';
const uploadFailed = 'PUBLISH_UPLOAD_FAILED';

const claimed = z.object({ claimed: z.literal(true), token: z.string() });

const context = (
  fake: FakeCoordination,
  publishedFiles?: readonly string[],
): ActionContext => ({
  owner: processA,
  staleAfterMs: claimStaleAfterMs,
  store: fake.store,
  ...(publishedFiles !== undefined && { publishedFiles }),
});

// A project whose calculations are current and whose publication is
// pending after an edit of a room.
const pendingPublication = (): FakeCoordination => {
  const fake = new FakeCoordination();
  fake.data.calculationFingerprint = graphA;
  fake.data.publicationFingerprint = graphA;
  fake.sourceWrite('rooms');
  return fake;
};

const claimPublication = async (
  fake: FakeCoordination,
  files?: readonly string[],
) =>
  claimed.parse(
    await runAction(
      { action: 'claim', domain: publication, retry: true },
      context(fake, files),
    ),
  ).token;

const uploaded = (bytes: number) => ({ bytes, outcome: 'uploaded' as const });
const failed = (code: string) => ({ code, outcome: 'failed' as const });

// Every declared file uploaded, except those named as failed.
const outcomesOf = (
  filenames: readonly string[],
  failures: readonly string[] = [],
) =>
  Object.fromEntries(
    filenames.map((filename, index) => [
      filename,
      failures.includes(filename) ? failed(uploadFailed) : uploaded(index + 2),
    ]),
  );

const failureOf = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
    return null;
  } catch (error) {
    return error;
  }
};

const [first = '', second = ''] = declaredFilenames;

// A Studio edit of the Flows: the fingerprints the graphs now have.
const changeGraphs = (
  fake: FakeCoordination,
  graphs: FakeCoordination['graphs'],
): void => {
  fake.graphs = graphs;
};

const invalidOptions = /Invalid coordination options/u;

const refusal = z.object({
  code: z.string(),
  message: z.string(),
  status: z.number(),
});

const refusalOf = async (work: Promise<unknown>) =>
  refusal.parse(await failureOf(work));

// One stored outcome of a file.
const outcome = (value: 'failed' | 'skipped' | 'uploaded') => ({
  bytes: null,
  code: value === 'uploaded' ? null : 'X',
  outcome: value,
  revision: 1,
});

describe('the declared files of a publication', () => {
  test('are the export definitions in publication order', () => {
    expect(declaredFilenames).toEqual([
      'courses.json',
      'rooms.json',
      'staff.json',
      'students.json',
    ]);
  });
});

describe('complete of a publication', () => {
  test('records every declared file uploaded, keyed by filename, at the claimed revision', async () => {
    const fake = pendingPublication();
    const token = await claimPublication(fake);
    const revision = fake.data.sourceRevision;

    await expect(
      runAction(
        {
          action: 'complete',
          files: outcomesOf(declaredFilenames),
          token,
        },
        context(fake),
      ),
    ).resolves.toMatchObject({ completed: true, domain: publication });
    expect(fake.data.publicationState).toBe('completed');
    expect(fake.data.completedRevision).toBe(revision);
    expect(fake.data.publicationFingerprint).toBe(graphA);
    expect(fake.data.dirtyDomains).toEqual([]);
    expect(fake.data.publicationOutcomes).toEqual(
      Object.fromEntries(
        declaredFilenames.map((filename, index) => [
          filename,
          { bytes: index + 2, code: null, outcome: 'uploaded', revision },
        ]),
      ),
    );
    await expect(statusAction(context(fake))).resolves.toMatchObject({
      publication: {
        files: fake.data.publicationOutcomes,
        state: 'completed',
      },
    });
  });

  test('refuses a filename no export definition declares and writes nothing', async () => {
    const fake = pendingPublication();
    const token = await claimPublication(fake);
    const before = structuredClone(fake.data);

    const refused = await refusalOf(
      runAction(
        {
          action: 'complete',
          files: {
            ...outcomesOf(declaredFilenames),
            'extra.json': uploaded(2),
          },
          token,
        },
        context(fake),
      ),
    );

    expect(refused).toMatchObject({
      code: 'COORDINATION_UNKNOWN_FILE',
      status: 400,
    });
    expect(refused.message).toContain('extra.json');
    expect(fake.data).toEqual(before);
  });

  test('never marks the revision published unless every declared file was uploaded', async () => {
    const fake = pendingPublication();
    const token = await claimPublication(fake);
    const withoutFirst = Object.fromEntries(
      Object.entries(outcomesOf(declaredFilenames)).filter(
        ([filename]) => filename !== first,
      ),
    );

    for (const files of [
      undefined,
      withoutFirst,
      outcomesOf(declaredFilenames, [second]),
    ]) {
      await expect(
        failureOf(
          runAction(
            files === undefined
              ? { action: 'complete', token }
              : { action: 'complete', files, token },
            context(fake),
          ),
        ),
      ).resolves.toMatchObject({
        code: 'COORDINATION_OUTCOMES_INCOMPLETE',
        status: 409,
      });
    }

    expect(fake.data.claim?.token).toBe(token);
    expect(fake.data.publicationState).toBe('running');
    expect(fake.data.publicationOutcomes).toBeNull();
  });

  test('refuses file outcomes on a calculation claim', async () => {
    const fake = new FakeCoordination();
    fake.sourceWrite('moodle_users');
    const token = claimed.parse(
      await runAction(
        { action: 'claim', domain: 'history_index', retry: false },
        context(fake),
      ),
    ).token;

    for (const action of ['complete', 'fail'] as const) {
      await expect(
        failureOf(
          runAction(
            action === 'complete'
              ? { action, files: outcomesOf([first]), token }
              : {
                  action,
                  code: 'X',
                  files: outcomesOf([first]),
                  message: null,
                  token,
                },
            context(fake),
          ),
        ),
      ).resolves.toMatchObject({
        code: 'COORDINATION_DOMAIN_MISMATCH',
        status: 400,
      });
    }

    expect(fake.data.claim?.token).toBe(token);
  });
});

describe('fail of a publication', () => {
  test('records partial with the outcome of every file when some were uploaded', async () => {
    const fake = pendingPublication();
    const token = await claimPublication(fake);
    const revision = fake.data.sourceRevision;
    const completedBefore = fake.data.completedRevision;

    await expect(
      runAction(
        {
          action: 'fail',
          code: 'PUBLICATION_PARTIAL',
          files: outcomesOf(declaredFilenames, [second]),
          message: `${second} failed`,
          token,
        },
        context(fake),
      ),
    ).resolves.toEqual({
      code: 'PUBLICATION_PARTIAL',
      domain: publication,
      failed: true,
      publication: 'partial',
      revision,
    });
    expect(fake.data.publicationState).toBe('partial');
    expect(fake.data.publicationOutcomes?.[second]).toEqual({
      bytes: null,
      code: uploadFailed,
      outcome: 'failed',
      revision,
    });
    expect(fake.data.publicationOutcomes?.[first]).toMatchObject({
      code: null,
      outcome: 'uploaded',
      revision,
    });
    // The revision is not published: publication stays pending, and the
    // accepted fingerprint and completed revision are those of before.
    expect(fake.data.dirtyDomains).toEqual([publication]);
    expect(fake.data.completedRevision).toBe(completedBefore);
    expect(fake.data.lastError).toMatchObject({
      code: 'PUBLICATION_PARTIAL',
      domain: publication,
      message: `${second} failed`,
      revision,
    });
  });

  test('records failed when no file was uploaded, and keeps earlier outcomes without a map', async () => {
    const fake = pendingPublication();
    const token = await claimPublication(fake);
    const nothing = Object.fromEntries(
      declaredFilenames.map((filename) => [filename, failed(uploadFailed)]),
    );

    await expect(
      runAction(
        {
          action: 'fail',
          code: 'PUBLICATION_FAILED',
          files: nothing,
          message: null,
          token,
        },
        context(fake),
      ),
    ).resolves.toMatchObject({ publication: 'failed' });
    expect(fake.data.publicationState).toBe('failed');

    const recorded = structuredClone(fake.data.publicationOutcomes);

    expect(Object.keys(recorded ?? {})).toEqual([...declaredFilenames]);

    const refused = await claimPublication(fake);

    await expect(
      runAction(
        {
          action: 'fail',
          code: 'PREPARATION_REFUSED',
          message: null,
          token: refused,
        },
        context(fake),
      ),
    ).resolves.toMatchObject({ publication: 'failed' });
    expect(fake.data.publicationOutcomes).toEqual(recorded);
  });

  test('refuses an undeclared filename and keeps the claim', async () => {
    const fake = pendingPublication();
    const token = await claimPublication(fake);

    await expect(
      failureOf(
        runAction(
          {
            action: 'fail',
            code: 'PUBLICATION_PARTIAL',
            files: { 'extra.json': failed(uploadFailed) },
            message: null,
            token,
          },
          context(fake),
        ),
      ),
    ).resolves.toMatchObject({ code: 'COORDINATION_UNKNOWN_FILE' });
    expect(fake.data.claim?.token).toBe(token);
  });
});

describe('a failed publication', () => {
  test('blocks under the publication fingerprint until a publication graph change', async () => {
    const fake = new FakeCoordination();
    fake.graphs = { calculation: 'calc-a', publication: 'pub-a' };
    fake.data.calculationFingerprint = 'calc-a';
    fake.data.publicationFingerprint = 'pub-a';
    fake.sourceWrite('rooms');
    const token = await claimPublication(fake);
    const claimWithoutRetry = () =>
      runAction(
        { action: 'claim', domain: publication, retry: false },
        context(fake),
      );

    await runAction(
      { action: 'fail', code: 'PUBLICATION_FAILED', message: null, token },
      context(fake),
    );

    await expect(claimWithoutRetry()).resolves.toMatchObject({
      claimed: false,
      reason: 'failed',
    });

    const failedReport = await statusAction(context(fake));

    expect(failedReport.domains['publication']?.state).toBe('failed');
    expect(failedReport.lastError?.blocking).toBeTruthy();

    // A publication-only graph change lifts it; the calculations stay
    // current.
    changeGraphs(fake, { calculation: 'calc-a', publication: 'pub-b' });
    const lifted = await statusAction(context(fake));

    expect(lifted.domains['publication']?.state).toBe('pending');
    expect(lifted.domains['enrollments']?.current).toBeTruthy();
    await expect(claimWithoutRetry()).resolves.toMatchObject({
      claimed: true,
    });
  });
});

describe('a publication superseded by a source change', () => {
  test('is recorded as published at its claimed revision and leaves the newer revision pending', async () => {
    const fake = pendingPublication();
    const token = await claimPublication(fake);
    const prepared = fake.data.sourceRevision;
    fake.sourceWrite('rooms');

    await expect(
      runAction(
        { action: 'complete', files: outcomesOf(declaredFilenames), token },
        context(fake),
      ),
    ).resolves.toEqual({
      completed: true,
      domain: publication,
      installed: 0,
      retries: 0,
      pendingRevision: prepared + 1,
      revision: prepared,
    });
    expect(fake.data.claim).toBeNull();
    expect(fake.data.publicationState).toBe('completed');
    expect(fake.data.completedRevision).toBe(prepared);
    expect(fake.data.publicationFingerprint).toBe(graphA);
    expect(fake.data.dirtyDomains).toEqual([publication]);
    expect(fake.data.sourceRevision).toBe(prepared + 1);
    expect(fake.data.publicationOutcomes?.[first]).toMatchObject({
      outcome: 'uploaded',
      revision: prepared,
    });

    const report = await statusAction(context(fake));

    expect(report.pending).toEqual([publication]);
    expect(report.publication.state).toBe('completed');
  });

  test('still needs every declared file uploaded, and keeps the claim otherwise', async () => {
    const fake = pendingPublication();
    const token = await claimPublication(fake);
    fake.sourceWrite('rooms');

    await expect(
      failureOf(
        runAction(
          {
            action: 'complete',
            files: outcomesOf(declaredFilenames, [second]),
            token,
          },
          context(fake),
        ),
      ),
    ).resolves.toMatchObject({ code: 'COORDINATION_OUTCOMES_INCOMPLETE' });
    expect(fake.data.claim?.token).toBe(token);
    expect(fake.data.completedRevision).toBe(0);
  });

  test('is overtaken when the publication graph changed as well, and keeps the outcomes of what it uploaded', async () => {
    const fake = pendingPublication();
    const token = await claimPublication(fake);
    const prepared = fake.data.sourceRevision;
    fake.sourceWrite('rooms');
    fake.graphs = { calculation: graphA, publication: 'graph-p2' };

    const refused = await refusalOf(
      runAction(
        { action: 'complete', files: outcomesOf(declaredFilenames), token },
        context(fake),
      ),
    );

    expect(refused.code).toBe('COORDINATION_FINGERPRINT_CHANGED');
    expect(refused.message).toContain('not recorded as published');
    expect(fake.data.claim).toBeNull();
    expect(fake.data.publicationState).toBe('idle');
    expect(fake.data.completedRevision).toBe(0);
    expect(fake.data.dirtyDomains).toEqual([publication]);
    // An upload cannot be discarded: the release keeps what was uploaded.
    expect(fake.data.publicationOutcomes?.[first]).toMatchObject({
      outcome: 'uploaded',
      revision: prepared,
    });
    expect(fake.data.lastError).toMatchObject({
      code: 'FINGERPRINT_CHANGED',
      revision: prepared,
    });
  });
});

describe('an overtaken publication', () => {
  test('by a publication graph change leaves the calculations current', async () => {
    const fake = pendingPublication();
    const token = await claimPublication(fake);
    fake.graphs = { calculation: graphA, publication: 'graph-p2' };

    await expect(
      failureOf(
        runAction(
          { action: 'complete', files: outcomesOf(declaredFilenames), token },
          context(fake),
        ),
      ),
    ).resolves.toMatchObject({ code: 'COORDINATION_FINGERPRINT_CHANGED' });

    const report = await statusAction(context(fake));

    expect(report.pending).toEqual([publication]);
    expect(report.domains['history_index']?.current).toBeTruthy();
    expect(report.domains['enrollments']?.current).toBeTruthy();
  });
});

describe('a registry with a fifth definition', () => {
  test('records five outcomes with no coordinator or schema change', async () => {
    const five = [...declaredFilenames, 'room-capacity.json'];
    const fake = pendingPublication();
    const token = await claimPublication(fake, five);

    await expect(
      failureOf(
        runAction(
          { action: 'complete', files: outcomesOf(declaredFilenames), token },
          context(fake, five),
        ),
      ),
    ).resolves.toMatchObject({ code: 'COORDINATION_OUTCOMES_INCOMPLETE' });

    await runAction(
      { action: 'complete', files: outcomesOf(five), token },
      context(fake, five),
    );

    expect(Object.keys(fake.data.publicationOutcomes ?? {})).toEqual(five);
    expect(fake.data.publicationState).toBe('completed');
  });
});

describe('the released publication state', () => {
  test('is idle when overtaken, partial with an upload at the claimed revision, failed otherwise', () => {
    expect(releasedPublicationState(false, null, 1)).toBe('idle');
    expect(
      releasedPublicationState(false, { 'a.json': outcome('uploaded') }, 1),
    ).toBe('idle');
    expect(releasedPublicationState(true, undefined, 1)).toBe('failed');
    expect(
      releasedPublicationState(
        true,
        {
          'a.json': outcome('failed'),
          'b.json': outcome('skipped'),
        },
        1,
      ),
    ).toBe('failed');
    expect(
      releasedPublicationState(
        true,
        {
          'a.json': outcome('uploaded'),
          'b.json': outcome('failed'),
        },
        1,
      ),
    ).toBe('partial');
    // An upload of an earlier run says nothing about this one.
    expect(
      releasedPublicationState(true, { 'a.json': outcome('uploaded') }, 2),
    ).toBe('failed');
    expect(
      releasedPublicationState(true, { 'a.json': outcome('uploaded') }, null),
    ).toBe('failed');
  });
});

describe('the outcome map options', () => {
  test('accept a filename-keyed map on complete and fail, as JSON text too', () => {
    const files = outcomesOf([first], [first]);

    expect(
      parseCoordinatorInput({
        action: 'fail',
        code: 'publication_partial',
        files: JSON.stringify(files),
        token: '6c6b4e8e-5c1d-4b3f-9a0e-1f2d3c4b5a69',
      }),
    ).toMatchObject({ code: 'PUBLICATION_PARTIAL', files });
    expect(
      parseCoordinatorInput({
        action: 'complete',
        files: outcomesOf([first]),
        token: '6c6b4e8e-5c1d-4b3f-9a0e-1f2d3c4b5a69',
      }),
    ).toMatchObject({ files: outcomesOf([first]) });
  });

  test('refuse outcomes that are not truthful or not bounded', () => {
    const token = '6c6b4e8e-5c1d-4b3f-9a0e-1f2d3c4b5a69';
    const refused = [
      { [first]: { code: uploadFailed, outcome: 'uploaded' } },
      { [first]: { outcome: 'failed' } },
      { [first]: { code: 'lower case', outcome: 'failed' } },
      { [first]: { outcome: 'published' } },
      { [first]: { extra: 1, outcome: 'uploaded' } },
      { [first]: { bytes: -1, outcome: 'uploaded' } },
      { '../x.json': uploaded(1) },
      { [first]: 'uploaded' },
      Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [
          `f${index}.json`,
          uploaded(1),
        ]),
      ),
    ];

    for (const files of refused) {
      expect(() =>
        parseCoordinatorInput({ action: 'complete', files, token }),
      ).toThrow(invalidOptions);
    }
  });
});

describe('the fake keeps both fingerprints', () => {
  test('changes both for a calculation graph change', () => {
    expect(bothGraphs('g')).toEqual({ calculation: 'g', publication: 'g' });
  });
});

// Task 16: the dashboard shows a publication retried at the same revision
// as done, not failed; the failure stays recorded without blocking.
describe('a publication retried at the same revision', () => {
  test('is current again once the retry completed, and its failure no longer blocks', async () => {
    const fake = pendingPublication();
    const failedRun = await claimPublication(fake);
    await runAction(
      {
        action: 'fail',
        code: 'PUBLICATION_PARTIAL',
        files: outcomesOf(declaredFilenames, [second]),
        message: `${second} was not uploaded`,
        token: failedRun,
      },
      context(fake),
    );
    const failedStatus = await statusAction(context(fake));

    expect(failedStatus.domains[publication]?.state).toBe('failed');
    expect(failedStatus.lastError?.blocking).toBeTruthy();

    const retry = await claimPublication(fake);
    await runAction(
      {
        action: 'complete',
        files: outcomesOf(declaredFilenames),
        token: retry,
      },
      context(fake),
    );
    const retried = await statusAction(context(fake));

    expect(retried.domains[publication]).toMatchObject({
      failed: false,
      pending: false,
      state: 'current',
    });
    expect(retried.lastError).toMatchObject({
      blocking: false,
      code: 'PUBLICATION_PARTIAL',
    });
  });
});
