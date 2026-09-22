import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { migrationCollectionKeys } from '../src/data-model/migration-collections.js';
import {
  fencedPatch,
  ledgerCollection,
} from '../src/migrations/ledger-claim.js';
import {
  LedgerRefusalError,
  type MigrationStep,
} from '../src/migrations/ledger-types.js';
import { readLedger, runLedger } from '../src/migrations/ledger.js';
import {
  mergeSourceMap,
  type SourceMapEntry,
  sourceMapEntrySchema,
} from '../src/migrations/source-map.js';
import {
  makeSyntheticDataset,
  type SyntheticDataset,
} from './fixtures/synthetic-data.js';
import {
  fakeItemsDirectus,
  type FakeStore,
  storeFromDataset,
} from './migration-test-helpers.js';

const version = 'relational-1';
const fingerprint = 'a'.repeat(64);
const otherFingerprint = 'b'.repeat(64);
const clockValue = '2026-09-22T10:00:00.000Z';
const byQuery = `/items/${ledgerCollection}?fields=id`;

const resumePattern = /--resume/u;
const setupPattern = /npm run setup/u;
const takenOverPattern = /another run/u;

const clock = (): string => clockValue;

const uniqueDataset = (base = makeSyntheticDataset()): SyntheticDataset => ({
  ...base,
  course_enrollment_patterns: base.course_enrollment_patterns.filter(
    (row) => row.id !== 2,
  ),
  course_equivalencies: base.course_equivalencies.filter((row) => row.id !== 2),
  curriculum_2018: base.curriculum_2018.filter((row) => row.id !== 9),
  curriculum_2023: base.curriculum_2023.filter((row) => row.id !== 2),
  students: base.students.filter((row) => row.id !== 2),
  teaching_assignments: base.teaching_assignments.filter((row) => row.id !== 2),
});

const installedStore = (): FakeStore =>
  storeFromDataset(uniqueDataset(), { installed: true });

const entryOf = (relation: string): SourceMapEntry => ({
  relation,
  sourceCollection: 'courses',
  sourceId: 1,
  status: 'existing',
  targetCollection: 'course_curricula',
  targetId: 1,
});

const step = (name: string, calls: string[], fail = false): MigrationStep => ({
  run: () => {
    calls.push(name);
    if (fail) {
      return Promise.reject(new Error(`${name} interrupted`));
    }
    return Promise.resolve([entryOf(name)]);
  },
  step: name,
});

const plan = (
  steps: readonly MigrationStep[],
  options: {
    readonly resume?: boolean;
    readonly runToken?: string;
    readonly sourceFingerprint?: string;
  } = {},
) => ({
  now: clock,
  resume: options.resume ?? false,
  runToken: options.runToken ?? 'run-1',
  sourceFingerprint: options.sourceFingerprint ?? fingerprint,
  steps,
  version,
});

const ledgerRows = (store: FakeStore) =>
  store.items.get(ledgerCollection) ?? [];

const relations = (entries: readonly SourceMapEntry[]): readonly string[] =>
  entries.map(({ relation }) => relation);

const relationsOf = (store: FakeStore): readonly string[] =>
  relations(
    z.array(sourceMapEntrySchema).parse(ledgerRows(store)[0]?.['id_map']),
  );

const recordedRow = (
  status: 'completed' | 'failed' | 'running',
  runToken: string,
  idMap: null | readonly SourceMapEntry[] = null,
) => ({
  error: null,
  finished_at: null,
  id: 1,
  id_map: idMap,
  key: `${version}/preflight`,
  run_token: runToken,
  source_fingerprint: fingerprint,
  started_at: '2026-09-22T09:00:00.000Z',
  status,
  step: 'preflight',
  version,
});

describe('migration ledger', () => {
  test('declares the private ledger collection in the relational model', () => {
    expect(ledgerCollection).toBe('migration_ledger');
    expect(migrationCollectionKeys).toEqual(['migration_ledger']);
  });

  test('records one completed row per step keyed by version and step', async () => {
    const store = installedStore();
    const { mutations, request } = fakeItemsDirectus(store);
    const calls: string[] = [];

    const outcome = await runLedger(
      request,
      plan([step('preflight', calls), step('curriculum', calls)]),
    );

    expect(calls).toEqual(['preflight', 'curriculum']);
    expect(outcome).toEqual({
      completed: ['preflight', 'curriculum'],
      skipped: [],
    });

    const rows = ledgerRows(store);

    expect(
      rows.map((row) => [row['key'], row['status'], row['source_fingerprint']]),
    ).toEqual([
      [`${version}/preflight`, 'completed', fingerprint],
      [`${version}/curriculum`, 'completed', fingerprint],
    ]);
    expect(rows[0]).toMatchObject({
      finished_at: clockValue,
      id_map: [expect.objectContaining({ relation: 'preflight', targetId: 1 })],
      run_token: 'run-1',
      started_at: clockValue,
      step: 'preflight',
      version,
    });
    expect(
      mutations().map(({ method, pathname }) => [method, pathname]),
    ).toEqual([
      ['POST', `/items/${ledgerCollection}`],
      ['PATCH', byQuery],
      ['POST', `/items/${ledgerCollection}`],
      ['PATCH', byQuery],
    ]);

    const ledger = await readLedger(request, version);

    expect(ledger.map(({ status, step: name }) => [name, status])).toEqual([
      ['preflight', 'completed'],
      ['curriculum', 'completed'],
    ]);
  });

  test('resumes after an interruption without repeating or double-recording a completed step', async () => {
    const store = installedStore();
    const { request } = fakeItemsDirectus(store);
    const calls: string[] = [];

    await expect(
      runLedger(
        request,
        plan([step('preflight', calls), step('curriculum', calls, true)]),
      ),
    ).rejects.toThrow('curriculum interrupted');

    const rows = ledgerRows(store);

    expect(rows.map((row) => [row['step'], row['status']])).toEqual([
      ['preflight', 'completed'],
      ['curriculum', 'failed'],
    ]);
    expect(rows[1]?.['error']).toBe('curriculum interrupted');

    const outcome = await runLedger(
      request,
      plan([step('preflight', calls), step('curriculum', calls)], {
        runToken: 'run-2',
      }),
    );

    expect(calls).toEqual(['preflight', 'curriculum', 'curriculum']);
    expect(outcome).toEqual({
      completed: ['curriculum'],
      skipped: ['preflight'],
    });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      error: null,
      run_token: 'run-2',
      status: 'completed',
    });
    expect(rows[0]).toMatchObject({ run_token: 'run-1' });
  });

  test('refuses to touch a step whose recorded source fingerprint differs', async () => {
    const store = installedStore();
    const { mutations, request } = fakeItemsDirectus(store);
    const calls: string[] = [];
    await runLedger(request, plan([step('preflight', calls)]));
    const before = mutations().length;

    await expect(
      runLedger(
        request,
        plan([step('preflight', calls), step('curriculum', calls)], {
          runToken: 'run-2',
          sourceFingerprint: otherFingerprint,
        }),
      ),
    ).rejects.toThrow(LedgerRefusalError);
    expect(calls).toEqual(['preflight']);
    expect(mutations()).toHaveLength(before);
  });

  test('persists entries recorded mid-step so an interrupted step hands them to its resumption', async () => {
    const store = installedStore();
    const { request } = fakeItemsDirectus(store);
    const previous: Array<readonly SourceMapEntry[]> = [];
    const recording: MigrationStep = {
      run: async (context) => {
        previous.push(context.previous);
        await context.record([entryOf('first')]);
        await context.record([entryOf('second')]);
        throw new Error('interrupted after recording');
      },
      step: 'preflight',
    };

    await expect(runLedger(request, plan([recording]))).rejects.toThrow(
      'interrupted after recording',
    );
    expect(ledgerRows(store)[0]).toMatchObject({
      id_map: [
        expect.objectContaining({ relation: 'first' }),
        expect.objectContaining({ relation: 'second' }),
      ],
      status: 'failed',
    });

    const resumed: MigrationStep = {
      run: (context) => {
        previous.push(context.previous);
        return Promise.resolve([entryOf('third')]);
      },
      step: 'preflight',
    };

    await expect(
      runLedger(request, plan([resumed], { runToken: 'run-2' })),
    ).resolves.toEqual({ completed: ['preflight'], skipped: [] });
    expect(previous.map((entries) => relations(entries))).toEqual([
      [],
      ['first', 'second'],
    ]);
    expect(ledgerRows(store)).toHaveLength(1);
    expect(relationsOf(store)).toEqual(['first', 'second', 'third']);
  });
});

describe('migration ledger recovery', () => {
  test('refuses a step another run holds unless the operator resumes it explicitly', async () => {
    const store = installedStore();
    const { request } = fakeItemsDirectus(store);
    ledgerRows(store).push(
      recordedRow('running', 'run-0', [
        {
          relation: 'entry',
          sourceCollection: 'curriculum_2023',
          sourceId: 1,
          status: 'existing',
          targetCollection: 'curriculum_entries',
          targetId: 5,
        },
      ]),
    );
    const calls: string[] = [];
    const previous: Array<readonly SourceMapEntry[]> = [];
    const resumable: MigrationStep = {
      run: (context) => {
        calls.push('preflight');
        previous.push(context.previous);
        return Promise.resolve([]);
      },
      step: 'preflight',
    };

    await expect(
      runLedger(request, plan([resumable], { runToken: 'run-2' })),
    ).rejects.toThrow(resumePattern);
    expect(calls).toEqual([]);

    const outcome = await runLedger(
      request,
      plan([resumable], { resume: true, runToken: 'run-2' }),
    );

    expect(outcome).toEqual({ completed: ['preflight'], skipped: [] });
    expect(calls).toEqual(['preflight']);
    expect(previous).toEqual([[expect.objectContaining({ targetId: 5 })]]);
    expect(ledgerRows(store)).toHaveLength(1);
    expect(ledgerRows(store)[0]).toMatchObject({
      run_token: 'run-2',
      status: 'completed',
    });
  });

  test('lets exactly one of two concurrent runs claim a new step', async () => {
    const store = installedStore();
    const { request } = fakeItemsDirectus(store);
    const calls: string[] = [];
    const racing: MigrationStep = {
      run: async () => {
        calls.push('outer');

        await expect(
          runLedger(
            request,
            plan([step('preflight', calls)], { runToken: 'run-b' }),
          ),
        ).rejects.toThrow(LedgerRefusalError);

        return [];
      },
      step: 'preflight',
    };

    const outcome = await runLedger(
      request,
      plan([racing], { runToken: 'run-a' }),
    );

    expect(outcome).toEqual({ completed: ['preflight'], skipped: [] });
    expect(calls).toEqual(['outer']);
    expect(ledgerRows(store)).toHaveLength(1);
  });

  test('lets exactly one of two concurrent runs re-claim a failed step', async () => {
    const store = installedStore();
    const { request } = fakeItemsDirectus(store);
    ledgerRows(store).push({
      ...recordedRow('failed', 'run-a'),
      error: 'synthetic interruption',
      finished_at: '2026-09-22T09:01:00.000Z',
    });
    const calls: string[] = [];

    const outcomes = await Promise.allSettled([
      runLedger(
        request,
        plan([step('preflight', calls)], { runToken: 'run-b' }),
      ),
      runLedger(
        request,
        plan([step('preflight', calls)], { runToken: 'run-c' }),
      ),
    ]);

    const [winner, loser] = outcomes;

    expect(winner).toEqual({
      status: 'fulfilled',
      value: { completed: ['preflight'], skipped: [] },
    });

    const reason: unknown = loser.status === 'rejected' ? loser.reason : null;

    expect(reason).toBeInstanceOf(LedgerRefusalError);
    expect(reason instanceof Error ? reason.message : '').toMatch(
      takenOverPattern,
    );
    expect(calls).toEqual(['preflight']);
    expect(ledgerRows(store)).toHaveLength(1);
    expect(ledgerRows(store)[0]).toMatchObject({
      error: null,
      run_token: 'run-b',
      status: 'completed',
    });
  });

  test('fences a run whose step was taken over: its recordings and completion refuse instead of overwriting', async () => {
    const store = installedStore();
    const { request } = fakeItemsDirectus(store);
    const calls: string[] = [];
    const slow: MigrationStep = {
      run: async (context) => {
        calls.push('slow');
        const takeover = await runLedger(
          request,
          plan([step('preflight', calls)], {
            resume: true,
            runToken: 'run-e',
          }),
        );

        expect(takeover).toEqual({ completed: ['preflight'], skipped: [] });
        await expect(context.record([entryOf('late')])).rejects.toThrow(
          takenOverPattern,
        );

        return [entryOf('slow')];
      },
      step: 'preflight',
    };

    await expect(
      runLedger(request, plan([slow], { runToken: 'run-d' })),
    ).rejects.toThrow(LedgerRefusalError);
    expect(calls).toEqual(['slow', 'preflight']);
    expect(ledgerRows(store)).toHaveLength(1);
    expect(ledgerRows(store)[0]).toMatchObject({
      id_map: [expect.objectContaining({ relation: 'preflight' })],
      run_token: 'run-e',
      status: 'completed',
    });
  });

  test('applies a fenced update only while the row carries the expected token and status', async () => {
    const store = installedStore();
    const { request } = fakeItemsDirectus(store);
    ledgerRows(store).push(recordedRow('running', 'run-a'));

    await expect(
      fencedPatch(
        request,
        { id: 1, run_token: 'run-z', status: 'running' },
        { status: 'completed' },
      ),
    ).resolves.toBe(false);
    expect(ledgerRows(store)[0]).toMatchObject({
      run_token: 'run-a',
      status: 'running',
    });
    await expect(
      fencedPatch(
        request,
        { id: 1, run_token: 'run-a', status: 'running' },
        { status: 'completed' },
      ),
    ).resolves.toBeTruthy();
    expect(ledgerRows(store)[0]).toMatchObject({ status: 'completed' });
  });

  test('refuses to run before the ledger collection exists', async () => {
    const store = storeFromDataset(uniqueDataset(), { installed: false });
    const { mutations, request } = fakeItemsDirectus(store);

    await expect(
      runLedger(request, plan([step('preflight', [])])),
    ).rejects.toThrow(setupPattern);
    expect(mutations()).toEqual([]);
  });
});

describe('source map', () => {
  test('merges entries by relation and source, later entries replacing earlier ones, in a stable order', () => {
    const pending = (sourceId: number): SourceMapEntry => ({
      relation: 'entry',
      sourceCollection: 'curriculum_2023',
      sourceId,
      status: 'pending',
      targetCollection: 'curriculum_entries',
      targetId: null,
    });
    const year: SourceMapEntry = {
      relation: 'label',
      sourceCollection: 'academic_years',
      sourceId: '2025/2026',
      status: 'existing',
      targetCollection: 'academic_years',
      targetId: 1,
    };
    const existing: SourceMapEntry = {
      ...pending(2),
      status: 'existing',
      targetId: 9,
    };

    expect(mergeSourceMap([pending(2), pending(1)], [existing, year])).toEqual([
      year,
      pending(1),
      existing,
    ]);
  });
});
