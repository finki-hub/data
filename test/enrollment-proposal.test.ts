import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { z } from 'zod';

import {
  type MappingConversionProposal,
  proposeMappingConversion,
} from '../src/migrations/enrollment-rules.js';
import {
  fingerprintInventory,
  fingerprintVersion,
} from '../src/migrations/fingerprint.js';
import { readInventory } from '../src/migrations/inventory.js';
import { preflight } from '../src/migrations/preflight.js';
import {
  proposalInputs,
  readProposalMappings,
} from '../src/migrations/proposal-inputs.js';
import { runMigrationCli } from '../src/migrations/run.js';
import { academicYears } from '../src/specs/public.js';
import {
  makeSyntheticDataset,
  type SyntheticDataset,
  withMetacharacterCourse,
} from './fixtures/synthetic-data.js';
import {
  fakeItemsDirectus,
  type FakeStore,
  storeFromDataset,
} from './migration-test-helpers.js';

const environment = {
  DIRECTUS_TOKEN: 'synthetic-token',
  DIRECTUS_URL: 'http://127.0.0.1:18055',
};
const privateText = /Alpha|Beta|C\+\+|Course-|Honors|Theta/u;
const modeKey = /"mode"/u;
const proposalOnly = /^Proposal only/u;
const privateHistory = 'Synthetic private history line';
const stdoutLine = z.record(z.string(), z.unknown());
const reportFile = z.looseObject({
  mappingProposal: z.looseObject({
    pairs: z.array(z.looseObject({ course: z.number() })),
    summary: z.record(z.string(), z.number()),
  }),
});
const yearLabels: readonly string[] = academicYears;

// A store with the relational model installed, the fifteen academic years
// seeded and the given explicit mappings of history entries.
const storeWithMappings = (
  mappings: ReadonlyArray<readonly [string, number, string]>,
  dataset: SyntheticDataset = makeSyntheticDataset(),
): FakeStore => {
  const store = storeFromDataset(dataset, { installed: true });
  const years = store.items.get('academic_years') ?? [];
  for (const [index, label] of yearLabels.entries()) {
    years.push({ id: 101 + index, label, sort: yearLabels.length - index });
  }
  const entries = store.items.get('moodle_course_entries') ?? [];
  const links = store.items.get('moodle_course_mappings') ?? [];
  for (const [index, [label, course, year]] of mappings.entries()) {
    const known = entries.find((row) => row['label'] === label);
    const entry = known?.id ?? entries.length + 1;
    if (known === undefined) {
      entries.push({
        id: entry,
        label,
        review_reason: null,
        review_state: 'mapped',
      });
    }
    links.push({
      academic_year: 101 + yearLabels.indexOf(year),
      course,
      entry,
      id: index + 1,
    });
  }
  return store;
};

const proposalOf = async (
  store: FakeStore,
  timeoutMs?: number,
): Promise<MappingConversionProposal> => {
  const { request } = fakeItemsDirectus(store);
  const inventory = await readInventory(request, {});
  const report = preflight(inventory, null);
  const mappings = await readProposalMappings(
    request,
    inventory.targets?.academic_years ?? [],
  );
  return proposeMappingConversion(
    proposalInputs(inventory, report, mappings),
    timeoutMs,
  );
};

const pairOf = (
  proposal: MappingConversionProposal,
  course: number,
  year: string,
) =>
  proposal.pairs.find(
    (pair) => pair.course === course && pair.academicYear === year,
  );

describe('mapping conversion proposal', () => {
  test('compares the matched user ids of the legacy rule and of its explicit mappings', async () => {
    const proposal = await proposalOf(
      storeWithMappings([
        ['Alpha Course-2024/2025', 1, '2024/2025'],
        ['Theta Course-2021/2022', 7, '2021/2022'],
        ['Theta Lab-2021/2022', 7, '2021/2022'],
      ]),
    );

    // Users 1 and 3 hold the entry; user 3 twice. The sets are the same.
    expect(pairOf(proposal, 1, '2024/2025')).toEqual({
      academicYear: '2024/2025',
      alternatives: [],
      course: 1,
      equal: true,
      invalid: false,
      legacy: 2,
      mapped: 2,
      mappings: 1,
      onlyLegacy: 0,
      onlyMapped: 0,
      sample: { onlyLegacy: [], onlyMapped: [] },
      timedOut: false,
    });
    // The cross-newline rule needs the lab right after the lecture; the
    // entry mappings also take user 6, who lists both apart.
    expect(pairOf(proposal, 7, '2021/2022')).toMatchObject({
      equal: false,
      legacy: 2,
      mapped: 3,
      mappings: 2,
      onlyLegacy: 0,
      onlyMapped: 1,
      sample: { onlyLegacy: [], onlyMapped: [6] },
    });
  });

  test('reports equal counts over different users as a difference', async () => {
    // Alpha 2024/2025 matches users 1 and 3; the Beta entry mapped to the
    // same pair is held by users 1 and 2. Two users each, not the same two.
    const proposal = await proposalOf(
      storeWithMappings([['Beta Course-2024/2025', 1, '2024/2025']]),
    );

    expect(pairOf(proposal, 1, '2024/2025')).toMatchObject({
      equal: false,
      legacy: 2,
      mapped: 2,
      onlyLegacy: 1,
      onlyMapped: 1,
      sample: { onlyLegacy: [3], onlyMapped: [2] },
    });
    expect(proposal.summary).toMatchObject({ differing: 1, equal: 0 });
  });

  test('lists a pair without mappings only as a count and never switches a mode', async () => {
    const proposal = await proposalOf(
      storeWithMappings([['Alpha Course-2024/2025', 1, '2024/2025']]),
    );

    expect(pairOf(proposal, 2, '2024/2025')).toBeUndefined();
    expect(proposal.summary).toEqual({
      alternatives: 1,
      compared: 1,
      differing: 0,
      equal: 1,
      invalid: 0,
      pairs: 120,
      timedOut: 0,
      unmapped: 119,
    });
    expect(proposal.note).toMatch(proposalOnly);
    expect(JSON.stringify(proposal)).not.toMatch(modeKey);
  });

  test('surfaces the superseded pattern rows of a pair with their matched-id differences', async () => {
    const proposal = await proposalOf(storeWithMappings([]));

    // Alpha 2025/2026 applies pattern row 2 (Honors: users 2, 3); the
    // superseded row 1 matches user 1 only.
    expect(pairOf(proposal, 1, '2025/2026')).toMatchObject({
      alternatives: [
        {
          equal: false,
          invalid: false,
          onlyAlternative: 1,
          onlyChosen: 2,
          row: 1,
          sample: { onlyAlternative: [1], onlyChosen: [2, 3] },
          timedOut: false,
        },
      ],
      legacy: 2,
      mappings: 0,
    });
  });

  test('flags a pattern that does not compile instead of comparing it', async () => {
    const proposal = await proposalOf(
      storeWithMappings(
        [['Alpha Course-2025/2026', 99, '2025/2026']],
        withMetacharacterCourse(makeSyntheticDataset()),
      ),
    );

    expect(pairOf(proposal, 99, '2025/2026')).toMatchObject({
      equal: false,
      invalid: true,
      legacy: 0,
      mapped: 1,
      onlyMapped: 1,
    });
    expect(proposal.summary.invalid).toBe(15);
  });

  test('samples at most five ids of each difference, ascending, and never a name or history', async () => {
    const base = makeSyntheticDataset();
    const users = Array.from({ length: 8 }, (_, index) => ({
      ...base.moodle_users[0],
      Courses: 'Beta Course-2024/2025',
      id: 20 + index,
    }));
    const proposal = await proposalOf(
      storeWithMappings([['Beta Course-2023/2024', 2, '2024/2025']], {
        ...base,
        moodle_users: [...base.moodle_users, ...users],
      }),
    );

    expect(pairOf(proposal, 2, '2024/2025')).toMatchObject({
      legacy: 10,
      mapped: 0,
      onlyLegacy: 10,
      sample: { onlyLegacy: [1, 2, 20, 21, 22], onlyMapped: [] },
    });
    expect(JSON.stringify(proposal)).not.toMatch(privateText);
  });
});

describe('bounded proposal expressions', () => {
  // A superseded pattern row the checkpoint never ran, and a chosen one,
  // both catastrophic on a run of "a": the proposal records them as timed
  // out within the deadline instead of holding the dry-run forever.
  test('reports an expression that runs out of time instead of hanging', async () => {
    const base = makeSyntheticDataset();
    const catastrophic = '(a+)+b';
    const dataset = {
      ...base,
      course_enrollment_patterns: [
        ...base.course_enrollment_patterns,
        {
          academic_year: '2024/2025',
          course_name: 'Alpha Course',
          id: 50,
          pattern: catastrophic,
        },
        {
          academic_year: '2024/2025',
          course_name: 'Alpha Course',
          id: 51,
          pattern: 'Alpha Course-2024/2025',
        },
        {
          academic_year: '2024/2025',
          course_name: 'Beta Course',
          id: 60,
          pattern: catastrophic,
        },
      ],
      moodle_users: [
        ...base.moodle_users,
        { ...base.moodle_users[0], Courses: 'a'.repeat(34), id: 30 },
      ],
    };
    const started = performance.now();
    const proposal = await proposalOf(
      storeWithMappings([['Beta Course-2024/2025', 2, '2024/2025']], dataset),
      100,
    );

    expect(performance.now() - started).toBeLessThan(5_000);
    expect(pairOf(proposal, 2, '2024/2025')).toMatchObject({
      equal: false,
      invalid: false,
      legacy: 0,
      mapped: 2,
      timedOut: true,
    });
    expect(pairOf(proposal, 1, '2024/2025')).toMatchObject({
      alternatives: [{ equal: false, invalid: false, row: 50, timedOut: true }],
      legacy: 2,
      timedOut: false,
    });
    expect(proposal.summary).toMatchObject({ differing: 1, timedOut: 2 });
    expect(JSON.stringify(proposal)).not.toContain(catastrophic);
  });
});

describe('migration dry-run proposal', () => {
  const scratch = { directory: '' };

  beforeEach(async () => {
    scratch.directory = await mkdtemp(
      path.join(os.tmpdir(), 'enrollment-proposal-'),
    );
  });

  afterEach(async () => {
    await rm(scratch.directory, { force: true, recursive: true });
  });

  test('writes the proposal into the private report and prints its counts only', async () => {
    const store = storeWithMappings([
      ['Theta Course-2021/2022', 7, '2021/2022'],
    ]);
    const fake = fakeItemsDirectus(store);
    const stdout: string[] = [];
    const reportPath = path.join(scratch.directory, 'report.json');

    await expect(
      runMigrationCli(['--dry-run', '--report', reportPath], environment, {
        createRequest: () => fake.request,
        now: () => '2026-09-23T10:00:00.000Z',
        runToken: () => 'run-token',
        stderr: () => {},
        stdout: (line) => {
          stdout.push(line);
        },
      }),
    ).resolves.toBe(0);
    expect(fake.mutations()).toEqual([]);

    const summary = stdoutLine.parse(JSON.parse(stdout[0] ?? '{}'));

    expect(summary['mappingProposal']).toEqual({
      alternatives: 1,
      compared: 1,
      differing: 1,
      equal: 0,
      invalid: 0,
      pairs: 120,
      timedOut: 0,
      unmapped: 119,
    });
    expect(stdout[0]).not.toMatch(privateText);

    const written = reportFile.parse(
      JSON.parse(await readFile(reportPath, 'utf8')),
    );

    expect(written.mappingProposal.pairs.map(({ course }) => course)).toContain(
      7,
    );
    expect(JSON.stringify(written.mappingProposal)).not.toMatch(privateText);
  });
});

describe('source fingerprint of the Moodle histories', () => {
  test('includes every raw history, so an edited history is drift', async () => {
    const store = storeFromDataset(makeSyntheticDataset(), { installed: true });
    const users = store.items.get('moodle_users') ?? [];
    users[8] = { ...users[8], Courses: privateHistory, id: 9 };
    const { calls, request } = fakeItemsDirectus(store);
    const inventory = await readInventory(request, {});
    const original = fingerprintInventory(inventory);
    const read = calls.find(({ pathname }) =>
      pathname.startsWith('/items/moodle_users?'),
    );

    expect(fingerprintVersion).toBe(3);
    expect(
      new URL(
        read?.pathname ?? '/',
        'https://fixture.example',
      ).searchParams.get('fields'),
    ).toBe('Courses,id');
    expect(inventory.checkpoint.moodle_users[3]).toEqual({
      Courses: 'Theta Course-2021/2022\nTheta Lab-2021/2022',
      id: 4,
    });

    users[3] = { ...users[3], Courses: 'Theta Course-2021/2022', id: 4 };

    const edited = await readInventory(fakeItemsDirectus(store).request, {});

    expect(fingerprintInventory(edited)).not.toBe(original);
    expect(JSON.stringify(inventory.checkpoint)).toContain(privateHistory);
    expect(JSON.stringify(preflight(inventory, null))).not.toContain(
      privateHistory,
    );
  });
});
