import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { CoordinationFacts } from '../directus/extensions/directus-extension-data-operations/src/exports/readiness-facts.js';
import type { SourceRead } from '../directus/extensions/directus-extension-data-operations/src/exports/types.js';
import type { FakeItem } from './migration-test-helpers.js';

import { exportActions } from '../directus/extensions/directus-extension-data-operations/src/exports/action-names.js';
import {
  exportsOperationId,
  parsedActions,
  runExportAction,
} from '../directus/extensions/directus-extension-data-operations/src/exports/actions.js';
import { definitionReads } from '../directus/extensions/directus-extension-data-operations/src/exports/definitions-check.js';
import { exportDefinitions } from '../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import {
  type ExportDeps,
  preparePublicFiles,
} from '../directus/extensions/directus-extension-data-operations/src/exports/prepare.js';
import { readinessRegistry } from '../directus/extensions/directus-extension-data-operations/src/exports/readiness-registry.js';
import { registryReads } from '../directus/extensions/directus-extension-data-operations/src/exports/registry-rules.js';
import { exportsOperation } from '../src/flows/flow-template.js';
import { expectedFiles, publicFileNames } from './expected-exports.js';
import {
  edit,
  importedStore,
  refusalOf,
  roomCapacity,
  storeReader,
} from './relational-export-helpers.js';

const current: CoordinationFacts = {
  calculation: 'graph-a',
  domains: { enrollments: 'current', history_index: 'current' },
  revision: 42,
};

const admin = { admin: true, user: 'synthetic-admin' };

type Setup = {
  // The coordinator facts answered at each call, the last one repeated.
  readonly coordination?: readonly CoordinationFacts[];
  readonly log?: SourceRead[];
  readonly store?: Parameters<typeof storeReader>[0];
};

const depsOf = async (setup: Setup = {}): Promise<ExportDeps> => {
  const answers = [...(setup.coordination ?? [current])];
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
    reader: storeReader(
      setup.store ?? (await importedStore()),
      setup.log ?? [],
    ),
    snapshot: () =>
      Promise.resolve({
        activeMatchesPromotion: true,
        activeRows: 9,
        state: 'completed',
      }),
  };
};

const exportReads = new Set(
  exportDefinitions.flatMap((definition) => [
    JSON.stringify(definition.rows),
    ...Object.values(definition.related).map((read) => JSON.stringify(read)),
  ]),
);

const recordText = /Synthetic|Course|Prof\./u;

// The prepare answer, with nothing beside its summary.
const prepareAnswer = z.strictObject({
  durationMs: z.strictObject({
    read: z.number().nonnegative(),
    serialize: z.number().nonnegative(),
    total: z.number().nonnegative(),
    validate: z.number().nonnegative(),
  }),
  files: z.array(
    z.strictObject({
      bytes: z.number(),
      filename: z.string(),
      rows: z.number(),
      sha256: z.string(),
    }),
  ),
  revision: z.number(),
  warnings: z.array(z.string()),
});

// Every row of the store but those of the course.
const withoutCourse =
  (course: number) =>
  (rows: FakeItem[]): FakeItem[] =>
    rows.filter((row) => row['course'] !== course);

const declaredReads = new Set(
  [
    ...registryReads(readinessRegistry),
    ...exportDefinitions.flatMap(definitionReads),
  ]
    .map(([, read]) => read)
    .map((read) => JSON.stringify(read)),
);

describe('the export operation', () => {
  test('is the operation the publication Flows call, with four actions', () => {
    expect(exportsOperationId).toBe(exportsOperation);
    expect(exportActions).toEqual([
      'readiness',
      'prepare',
      'stage',
      'outcomes',
    ]);
    // The Studio form's zod-free list is the schema's.
    expect(parsedActions).toEqual([...exportActions]);
  });

  test('serves administrators only, before it builds a reader', async () => {
    let built = 0;
    const deps = () => {
      built += 1;
      return depsOf();
    };

    for (const accountability of [null, { admin: false, user: 'u' }, {}]) {
      await expect(
        runExportAction({ action: 'prepare' }, { accountability, deps }),
      ).rejects.toMatchObject({ code: 'EXPORT_FORBIDDEN', status: 403 });
    }

    await expect(
      runExportAction({ action: 'publish' }, { accountability: admin, deps }),
    ).rejects.toMatchObject({ code: 'EXPORT_INVALID_OPTIONS', status: 400 });
    expect(built).toBe(0);
  });

  test('prepares exactly the committed parity files and answers only their sizes and digests', async () => {
    const expected = await expectedFiles('parity');
    const answer = await runExportAction(
      { action: 'prepare' },
      { accountability: admin, deps: () => depsOf() },
    );
    const { durationMs, ...summary } = prepareAnswer.parse(answer);

    expect(durationMs.total).toBeGreaterThanOrEqual(durationMs.read);
    expect(summary).toEqual({
      files: publicFileNames.map((name) => ({
        bytes: Buffer.byteLength(expected[name].body, 'utf8'),
        filename: `${name}.json`,
        rows: z.array(z.unknown()).parse(JSON.parse(expected[name].body))
          .length,
        sha256: expected[name].sha256,
      })),
      revision: 42,
      warnings: [
        'equivalency_without_course',
        'equivalency_entry_unresolved',
        'assignment_review_label',
        'council_member_unresolved',
      ],
    });
    expect(JSON.stringify(answer)).not.toMatch(recordText);
  });

  test('answers readiness alone without reading any file', async () => {
    const log: SourceRead[] = [];
    const answer = await runExportAction(
      { action: 'readiness' },
      { accountability: admin, deps: () => depsOf({ log }) },
    );

    expect(answer).toMatchObject({ ready: true, revision: 42 });
    expect(log.filter((read) => exportReads.has(JSON.stringify(read)))).toEqual(
      [],
    );
  });
});

describe('the preparation', () => {
  test('refuses before any file is read while not ready', async () => {
    const log: SourceRead[] = [];
    const store = edit(
      await importedStore(),
      'course_enrollments',
      withoutCourse(2),
    );
    const refusal = await refusalOf(async () =>
      preparePublicFiles(
        exportDefinitions,
        await depsOf({
          coordination: [
            {
              ...current,
              domains: { enrollments: 'pending', history_index: 'current' },
            },
          ],
          log,
          store,
        }),
      ),
    );

    expect(refusal).toEqual({
      code: 'EXPORT_NOT_READY',
      message:
        'Not ready at source revision 42: enrollments_pending 1, enrollment_count_missing 15. Nothing was prepared; "Data / Validate readiness" lists every issue with its Studio page.',
    });
    expect(log.length).toBeGreaterThan(0);
    expect(log.filter((read) => exportReads.has(JSON.stringify(read)))).toEqual(
      [],
    );
  });

  test.each([
    ['the source revision moved', { ...current, revision: 43 }],
    [
      'a calculation turned pending at the same revision',
      {
        ...current,
        domains: { enrollments: 'pending', history_index: 'current' },
      },
    ],
    [
      'another calculation was accepted',
      { ...current, calculation: 'graph-b' },
    ],
  ])('refuses the files when %s meanwhile', async (_label, after) => {
    await expect(
      refusalOf(async () =>
        preparePublicFiles(
          exportDefinitions,
          await depsOf({ coordination: [current, after] }),
        ),
      ),
    ).resolves.toMatchObject({ code: 'EXPORT_UNSTABLE_PREPARATION' });
  });

  test('prepares a fifth declared file after the four with no other change', async () => {
    const prepared = await preparePublicFiles(
      [...exportDefinitions, roomCapacity],
      await depsOf(),
    );

    expect(
      prepared.files.map(({ filename, rows }) => [filename, rows]),
    ).toEqual([
      ['courses.json', 8],
      ['rooms.json', 3],
      ['staff.json', 7],
      ['students.json', 3],
      ['room-capacity.json', 3],
    ]);
    expect(JSON.parse(prepared.files[4]?.body ?? 'null')).toEqual([
      { room: 'Synthetic Room 101', seats: '24', large: 'TRUE' },
      { room: 'Synthetic Hall 2', seats: '0', large: 'FALSE' },
      { room: 'Synthetic Storage' },
    ]);
  });

  test('refuses a malformed definition before anything is read', async () => {
    const log: SourceRead[] = [];

    await expect(
      refusalOf(async () =>
        preparePublicFiles(
          [...exportDefinitions, { ...roomCapacity, filename: 'Rooms.JSON' }],
          await depsOf({ log }),
        ),
      ),
    ).resolves.toMatchObject({ code: 'EXPORT_INVALID_DEFINITION' });
    expect(log).toEqual([]);
  });

  test('reads every declared source once and only through explicit fields', async () => {
    const log: SourceRead[] = [];
    await preparePublicFiles(exportDefinitions, await depsOf({ log }));
    const made = log.map((read) => JSON.stringify(read));

    expect(made.filter((read) => !declaredReads.has(read))).toEqual([]);
    expect(new Set(made).size).toBe(made.length);
    expect(log.flatMap((read) => read.fields)).not.toContain('*');
  });
});
