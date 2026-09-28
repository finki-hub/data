import type { Readable } from 'node:stream';

import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { ActionContext } from '../directus/extensions/directus-extension-data-operations/src/coordination/action-support.js';
import type { CoordinationFacts } from '../directus/extensions/directus-extension-data-operations/src/exports/readiness-facts.js';
import type { ExportDefinition } from '../directus/extensions/directus-extension-data-operations/src/exports/types.js';

import { runAction } from '../directus/extensions/directus-extension-data-operations/src/coordination/actions.js';
import { parseCoordinatorInput } from '../directus/extensions/directus-extension-data-operations/src/coordination/options.js';
import { claimStaleAfterMs } from '../directus/extensions/directus-extension-data-operations/src/coordination/state.js';
import { exportActions } from '../directus/extensions/directus-extension-data-operations/src/exports/action-names.js';
import { runExportAction } from '../directus/extensions/directus-extension-data-operations/src/exports/actions.js';
import { exportDefinitions } from '../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { type ExportDeps } from '../directus/extensions/directus-extension-data-operations/src/exports/prepare.js';
import publishOperation from '../directus/extensions/directus-extension-publish-json/api.js';
import { publishFileFlow } from '../src/flows/publish-one-file.js';
import { FakeCoordination } from './data-coordination-helpers.js';
import {
  edit,
  importedStore,
  roomCapacity,
  storeReader,
} from './relational-export-helpers.js';

const admin = { admin: true, user: 'synthetic-admin' };
const token = '6c6b4e8e-5c1d-4b3f-9a0e-1f2d3c4b5a69';
const current: CoordinationFacts = {
  calculation: 'graph-a',
  domains: { enrollments: 'current', history_index: 'current' },
  revision: 42,
};

const depsOf = async (
  coordination: readonly CoordinationFacts[] = [current],
  store?: Awaited<ReturnType<typeof importedStore>>,
): Promise<ExportDeps> => {
  const answers = [...coordination];
  let clock = 0;
  return {
    coordination: () =>
      Promise.resolve(
        (answers.length > 1 ? answers.shift() : answers[0]) ?? current,
      ),
    now: () => {
      clock += 5;
      return clock;
    },
    reader: storeReader(store ?? (await importedStore()), []),
    snapshot: () =>
      Promise.resolve({
        activeMatchesPromotion: true,
        activeRows: 9,
        state: 'completed',
      }),
  };
};

const run = (
  options: unknown,
  definitions: readonly ExportDefinition[] = exportDefinitions,
  deps: () => Promise<ExportDeps> = () => depsOf(),
) => runExportAction(options, { accountability: admin, definitions, deps });

const upload = z.strictObject({
  bytes: z.number(),
  claim: z.string(),
  filename: z.string(),
  objects: z.record(z.string(), z.unknown()),
  sha256: z.string(),
});

const staged = z.object({
  files: z.array(
    z.strictObject({
      bytes: z.number(),
      filename: z.string(),
      rows: z.number(),
      sha256: z.string(),
    }),
  ),
  revision: z.number(),
  uploads: z.array(upload),
});

const outcomesAnswer = z.strictObject({
  code: z.string().nullable(),
  failed: z.array(z.string()),
  files: z.record(z.string(), z.unknown()),
  message: z.string(),
  ok: z.boolean(),
  uploaded: z.array(z.string()),
});

const refusal = z.object({
  code: z.string(),
  message: z.string(),
  status: z.number(),
});

const refusalOf = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    return refusal.parse(error);
  }
  throw new Error('The action answered instead of refusing');
};

// Every row of a collection but those of the course.
const withoutCourse =
  (course: number) =>
  <Row extends Readonly<Record<string, unknown>>>(rows: Row[]): Row[] =>
    rows.filter((row) => row['course'] !== course);

const filenames = (definitions: readonly ExportDefinition[]) =>
  definitions.map(({ filename }) => filename);

// What a child answers, as its transforms say (publish-one-file.ts).
const answered = (
  filename: string,
  result:
    | { readonly bytes: number }
    | { readonly code: string; readonly message: string },
) =>
  'bytes' in result
    ? {
        bytes: result.bytes,
        code: null,
        filename,
        ok: true,
        outcome: 'uploaded',
      }
    : {
        bytes: null,
        code: result.code,
        filename,
        message: result.message,
        ok: false,
        outcome: 'failed',
      };

describe('the stage action', () => {
  test('is one of the four actions of the export operation', () => {
    expect(exportActions).toEqual([
      'readiness',
      'prepare',
      'stage',
      'outcomes',
    ]);
  });

  test('prepares every declared file and hands one single-entry upload per file to the loop, in order', async () => {
    const prepared = await run({ action: 'prepare' });
    const answer = staged.parse(
      await run({ action: 'stage', revision: 42, token }),
    );

    expect(answer.revision).toBe(42);
    expect(answer.files).toEqual(
      z.object({ files: z.array(z.unknown()) }).parse(prepared).files,
    );
    expect(answer.uploads.map(({ filename }) => filename)).toEqual(
      filenames(exportDefinitions),
    );

    for (const [index, entry] of answer.uploads.entries()) {
      const summary = answer.files[index];

      expect(Object.keys(entry.objects)).toEqual([entry.filename]);
      expect(entry.claim).toBe(token);
      // The writer stringifies the value: exactly the validated bytes.
      expect(
        Buffer.byteLength(JSON.stringify(entry.objects[entry.filename])),
      ).toBe(summary?.bytes);
      expect(entry.sha256).toBe(summary?.sha256);
    }
  });

  test('refuses when the source moved since the claim, before any upload', async () => {
    const refused = await refusalOf(
      run({ action: 'stage', revision: 41, token }),
    );

    expect(refused).toMatchObject({
      code: 'EXPORT_UNSTABLE_PREPARATION',
      status: 409,
    });
    expect(refused.message).toContain('nothing was uploaded');
  });

  test('refuses while readiness has a blocker, with its codes', async () => {
    const store = edit(
      await importedStore(),
      'course_enrollments',
      withoutCourse(2),
    );
    const refused = await refusalOf(
      run({ action: 'stage', revision: 42, token }, exportDefinitions, () =>
        depsOf([current], store),
      ),
    );

    expect(refused.code).toBe('EXPORT_NOT_READY');
    expect(refused.message).toContain('enrollment_count_missing');
  });

  test('refuses a revision or token that is not the claim’s', async () => {
    for (const options of [
      { action: 'stage', token },
      { action: 'stage', revision: 42 },
      { action: 'stage', revision: -1, token },
      { action: 'stage', revision: 42, token: 'not-a-token' },
    ]) {
      await expect(run(options)).rejects.toMatchObject({
        code: 'EXPORT_INVALID_OPTIONS',
      });
    }
  });
});

describe('the outcomes action', () => {
  const declared = filenames(exportDefinitions);
  const [first = '', second = '', third = '', fourth = ''] = declared;

  test('answers ok with every declared file uploaded, keyed by filename in definition order', async () => {
    const answer = outcomesAnswer.parse(
      await run({
        action: 'outcomes',
        results: declared.map((filename, index) =>
          answered(filename, { bytes: index + 2 }),
        ),
      }),
    );

    expect(answer).toMatchObject({
      code: null,
      failed: [],
      ok: true,
      uploaded: declared,
    });
    expect(Object.keys(answer.files)).toEqual(declared);
    expect(answer.files[first]).toEqual({ bytes: 2, outcome: 'uploaded' });
  });

  test('answers partial with the failed file’s code when some were uploaded', async () => {
    const answer = outcomesAnswer.parse(
      await run({
        action: 'outcomes',
        results: [
          answered(first, { bytes: 2 }),
          answered(second, {
            code: 'PUBLISH_UPLOAD_FAILED',
            message: 'Uploading failed: InternalError',
          }),
          answered(third, { bytes: 4 }),
          answered(fourth, { bytes: 5 }),
        ],
      }),
    );

    expect(answer).toMatchObject({
      code: 'PUBLICATION_PARTIAL',
      failed: [second],
      ok: false,
      uploaded: [first, third, fourth],
    });
    expect(answer.files[second]).toEqual({
      code: 'PUBLISH_UPLOAD_FAILED',
      outcome: 'failed',
    });
    expect(answer.message).toContain(`${second} (PUBLISH_UPLOAD_FAILED`);
    expect(answer.message).toContain('not recorded as published');
  });

  test('answers failed when nothing was uploaded, and fills an unanswered or garbled file as failed', async () => {
    const answer = outcomesAnswer.parse(
      await run({
        action: 'outcomes',
        results: [
          null,
          answered(second, { code: 'undefined', message: 'x' }),
          { filename: third, ok: 'yes' },
          answered(fourth, { code: 'PUBLISH_UPLOAD_FAILED', message: 'y' }),
        ],
      }),
    );

    expect(answer).toMatchObject({
      code: 'PUBLICATION_FAILED',
      failed: declared,
      ok: false,
      uploaded: [],
    });
    expect(answer.files).toEqual({
      [first]: { code: 'NO_ANSWER', outcome: 'failed' },
      [fourth]: { code: 'PUBLISH_UPLOAD_FAILED', outcome: 'failed' },
      [second]: { code: 'PUBLISH_FAILED', outcome: 'failed' },
      [third]: { code: 'NO_ANSWER', outcome: 'failed' },
    });
  });

  test('never counts an inconsistent answer as uploaded', async () => {
    const answer = outcomesAnswer.parse(
      await run({
        action: 'outcomes',
        results: [
          {
            code: 'PUBLISH_UPLOAD_FAILED',
            filename: first,
            ok: true,
            outcome: 'failed',
          },
          { code: null, filename: second, ok: false, outcome: 'uploaded' },
          answered(third, { bytes: 4 }),
          answered(fourth, { bytes: 5 }),
        ],
      }),
    );

    expect(answer).toMatchObject({
      failed: [first, second],
      uploaded: [third, fourth],
    });
    expect(answer.files[first]).toEqual({
      code: 'PUBLISH_UPLOAD_FAILED',
      outcome: 'failed',
    });
    expect(answer.files[second]).toEqual({
      code: 'PUBLISH_FAILED',
      outcome: 'failed',
    });
  });

  test('refuses an answer for a file no definition declares, or one file answered twice', async () => {
    for (const results of [
      [answered('extra.json', { bytes: 1 })],
      [answered(first, { bytes: 1 }), answered(first, { bytes: 1 })],
      'not a list',
    ]) {
      await expect(run({ action: 'outcomes', results })).rejects.toMatchObject({
        code: 'EXPORT_INVALID_OPTIONS',
        status: 400,
      });
    }
  });
});

const lookup = z.object({
  filter: z.object({ filename_disk: z.object({ _eq: z.string() }) }),
});

// A storage refusal as the S3 client raises it.
class InternalError extends Error {
  public override readonly name = 'InternalError';
}

// A FilesService stand-in: every upload recorded, the one at a position
// refused the way a storage failure surfaces.
const filesService = (uploads: string[], failAt: number) =>
  class {
    readonly #uploads = uploads;

    // A file is found once this stand-in stored it.
    public async readByQuery(
      query: unknown,
    ): Promise<ReadonlyArray<{ id: string }>> {
      const name = lookup.parse(query).filter.filename_disk._eq;
      return this.#uploads.includes(name) ? [{ id: name }] : [];
    }

    public async uploadOne(
      stream: Readable,
      metadata: { readonly filename_disk: string },
    ): Promise<string> {
      await stream.toArray();
      if (this.#uploads.length + 1 === failAt) {
        this.#uploads.push(`failed:${metadata.filename_disk}`);
        throw new InternalError('We encountered an internal error.');
      }
      this.#uploads.push(metadata.filename_disk);
      return metadata.filename_disk;
    }
  };

// The options of a step of Publish / One file, with its exact templates
// rendered from a scope as the Flow engine renders them.
const childOptions = (
  key: string,
  scope: ReadonlyMap<string, unknown>,
): Record<string, unknown> => {
  const step = publishFileFlow.operations.find(
    (operation) => operation.key === key,
  );
  return Object.fromEntries(
    Object.entries(step?.options ?? {}).map(([name, value]) => [
      name,
      typeof value === 'string' && scope.has(value) ? scope.get(value) : value,
    ]),
  );
};

// One run of the publish Flow over a registry, in this process: the stage
// action, the child's upload through the existing writer and its
// answers, the outcomes action and the coordinator. The Flow and the
// schema are the shipped ones; only the definitions list grows.
const publishWith = async (
  definitions: readonly ExportDefinition[],
  failAt: number,
) => {
  const fake = new FakeCoordination();
  fake.data.calculationFingerprint = 'graph-a';
  fake.data.publicationFingerprint = 'graph-a';
  fake.sourceWrite('rooms');
  const context: ActionContext = {
    owner: 'process-a',
    publishedFiles: filenames(definitions),
    staleAfterMs: claimStaleAfterMs,
    store: fake.store,
  };
  const claim = z
    .object({ revision: z.number(), token: z.string() })
    .parse(
      await runAction(
        { action: 'claim', domain: 'publication', retry: true },
        context,
      ),
    );
  const facts = { ...current, revision: claim.revision };
  const answer = staged.parse(
    await run(
      { action: 'stage', revision: claim.revision, token: claim.token },
      definitions,
      () => depsOf([facts]),
    ),
  );
  const uploads: string[] = [];
  const results = [];
  for (const entry of answer.uploads) {
    const scope: ReadonlyArray<readonly [string, unknown]> = [
      ['{{ $trigger.claim }}', claim.token],
      ['{{ $trigger.filename }}', entry.filename],
    ];
    try {
      const published = await publishOperation.handler(
        { objects: entry.objects, storage: 'publish' },
        {
          database: {},
          getSchema: async () => ({}),
          services: { FilesService: filesService(uploads, failAt) },
        },
      );
      const { bytes } = z.object({ bytes: z.number() }).parse(published);
      await runAction(
        parseCoordinatorInput(
          childOptions(
            'record_uploaded',
            new Map([...scope, ['{{ upload.bytes }}', bytes]]),
          ),
        ),
        context,
      );
      results.push(answered(entry.filename, published));
    } catch (error) {
      const refused = z
        .object({ code: z.string(), message: z.string() })
        .parse(error);
      await runAction(
        parseCoordinatorInput(
          childOptions(
            'record_failed',
            new Map([...scope, ['{{ upload.code }}', refused.code]]),
          ),
        ),
        context,
      );
      results.push(answered(entry.filename, refused));
    }
  }
  // What the loop recorded file by file, before the parent's last step.
  const recorded = structuredClone(fake.data.publicationOutcomes);
  const outcomes = outcomesAnswer.parse(
    await run({ action: 'outcomes', results }, definitions),
  );
  // The coordinate operation parses what the parent's templates pass.
  await runAction(
    parseCoordinatorInput(
      outcomes.ok
        ? { action: 'complete', files: outcomes.files, token: claim.token }
        : {
            action: 'fail',
            code: outcomes.code,
            files: outcomes.files,
            message: outcomes.message,
            token: claim.token,
          },
    ),
    context,
  );
  return { fake, outcomes, recorded, uploads };
};

describe('a registry with a fifth definition', () => {
  const five = [...exportDefinitions, roomCapacity];

  test('publishes and records five outcomes with no Flow or schema change', async () => {
    const { fake, uploads } = await publishWith(five, 0);

    expect(uploads).toEqual(filenames(five));
    expect(fake.data.publicationState).toBe('completed');
    expect(Object.keys(fake.data.publicationOutcomes ?? {})).toEqual(
      filenames(five),
    );
    // The child the Flow runs per file names no file at all.
    expect(JSON.stringify(publishFileFlow)).not.toContain('.json');
  });

  test('attempts every file after the second failed and records partial truthfully', async () => {
    const { fake, outcomes, recorded, uploads } = await publishWith(five, 2);
    const names = filenames(five);
    const summary = (files: typeof recorded) =>
      Object.entries(files ?? {}).map(([filename, { code, outcome }]) => [
        filename,
        outcome,
        code,
      ]);

    expect(uploads).toEqual([
      names[0],
      `failed:${names[1] ?? ''}`,
      ...names.slice(2),
    ]);
    expect(outcomes.failed).toEqual([names[1]]);
    expect(fake.data.publicationState).toBe('partial');

    const truthful = names.map((filename, index) =>
      index === 1
        ? [filename, 'failed', 'PUBLISH_UPLOAD_FAILED']
        : [filename, 'uploaded', null],
    );

    expect(summary(fake.data.publicationOutcomes)).toEqual(truthful);
    // The child recorded every file's outcome as it went, before the
    // parent's fail: a run stopped there would already show them.
    expect(summary(recorded)).toEqual(truthful);
    expect(fake.data.dirtyDomains).toEqual(['publication']);
  });
});
