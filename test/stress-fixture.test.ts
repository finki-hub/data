import { describe, expect, it } from 'vitest';

import type { ExportDefinition } from '../directus/extensions/directus-extension-data-operations/src/exports/types.js';

import { exportDefinitions } from '../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import {
  labelBytes,
  splitHistoryEntries,
} from '../directus/extensions/directus-extension-data-operations/src/history-contract.js';
import { ruleMode } from '../directus/extensions/directus-extension-data-operations/src/rule-modes.js';
import {
  boundedFields,
  historyField,
  instanceIdFields,
  integerFields,
  requiredFields,
  snapshotFields,
} from '../directus/extensions/directus-extension-data-operations/src/snapshot/contract.js';
import { workbookGenerations } from '../src/migrations/generations.js';
import {
  curriculumPlan,
  declarations,
  expectedFiles,
  modelRows,
  referenceCollections,
  yearRows,
} from './fixtures/stress-fixture.js';
import { expectedCounts, pairKey } from './fixtures/stress-oracle.js';
import {
  courseName,
  csvHeader,
  csvOrder,
  declaredSnapshot,
  historiesOf,
  indexOf,
  longHistoryLines,
  type SnapshotDeclaration,
  stressLabels,
  stressLines,
  stressRows,
} from './fixtures/stress-snapshot.js';
import { academicYears } from './fixtures/synthetic-data.js';
import { syntheticPrograms } from './fixtures/synthetic-workbook.js';

// The generated stress fixture follows its declarations: the scraper
// header set, the model's academic years, the generation and program rows
// it creates and the export registry. Each test adds a test-only member
// to one declaration and checks that the fixture changes with it, with no
// edit to the builder.

const fullSize = { courses: 400, labels: 5_000, users: 30_000 };
const mapped = ruleMode('mapped_entries').mode;
const legacy = ruleMode('legacy_regex').mode;

const lineBreak = /\r?\n/u;
const scripts = [/\p{Script=Cyrillic}/u, /\p{Script=Han}/u, /😀/u];
const collator = new Intl.Collator('en');
const sorted = (labels: Iterable<string>) =>
  Array.from(labels).toSorted((left, right) => collator.compare(left, right));

// Whether a history line matches no rule of the fixture.
const matchesNothing =
  (matching: ReadonlySet<string>) =>
  (line: readonly string[]): boolean =>
    line.length > 0 && line.every((entry) => !matching.has(entry));

const courseNames = (count: number) =>
  Array.from({ length: count }, (_, index) => courseName(index));

const fixtureRows = (
  declaration: SnapshotDeclaration,
  size: { courses: number; labels: number; users: number },
  years: readonly string[] = declarations.years,
) => {
  const labels = stressLabels(
    courseNames(size.courses),
    yearRows(years).map(({ label }) => label),
    size.labels,
  );
  const rows = stressRows(size.users, { declaration, labels, offset: 0 });
  return { labels, lines: stressLines(size.users, labels), rows };
};

const column = (
  declaration: SnapshotDeclaration,
  rows: ReturnType<typeof fixtureRows>['rows'],
  field: string,
) => {
  const position = declaration.fields.indexOf(field);
  return rows.map((row) => row[position]);
};

describe('the builder reads the declarations themselves', () => {
  it('takes the scraper columns from the snapshot contract', () => {
    expect(declarations.snapshot).toBe(declaredSnapshot);
    expect(declaredSnapshot.fields).toBe(snapshotFields);
    expect(declaredSnapshot.bounded).toBe(boundedFields);
    expect(declaredSnapshot.history).toBe(historyField);
    expect(declaredSnapshot.instanceIds).toBe(instanceIdFields);
    expect(declaredSnapshot.integers).toBe(integerFields);
    expect(declaredSnapshot.required).toBe(requiredFields);
  });

  it('takes the years from the model and the files from the export registry', () => {
    expect(declarations.years).toBe(academicYears);
    expect(declarations.definitions).toBe(exportDefinitions);
  });

  it('takes the generations and programs from the seeds the import declares', () => {
    expect(declarations.generations).toEqual(
      workbookGenerations.map(
        ({ code, has_curriculum, label, published, sort }) => ({
          code,
          has_curriculum,
          label,
          published,
          sort,
        }),
      ),
    );
    expect(declarations.programs).toEqual(syntheticPrograms);
  });
});

describe('the stress snapshot follows the scraper header declaration', () => {
  const full = fixtureRows(declarations.snapshot, fullSize);
  const histories = historiesOf(declarations.snapshot, full.rows);

  it('holds exactly the declared number of distinct history labels', () => {
    const { labels } = indexOf(full.lines);

    expect(labels.size).toBe(fullSize.labels);
    expect(sorted(labels)).toEqual(sorted(full.labels.labels));
    expect(
      [...labels].every((label) => labelBytes(label) < 2_048),
    ).toBeTruthy();
  });

  it('writes raw histories whose entries are exactly the lines it chose', () => {
    const entries = histories.map((history) => splitHistoryEntries(history));
    const chosen = full.lines.map((lines) => [...new Set(lines)]);

    expect(entries).toEqual(chosen);
    expect(indexOf(full.lines).memberships).toBe(
      entries.reduce((total, own) => total + own.length, 0),
    );
  });

  it('spreads every edge case the stress run needs over the users', () => {
    const lines = histories.map((history) =>
      history === null ? [] : history.split(lineBreak),
    );

    expect(histories.filter((history) => history === null)).toHaveLength(75);
    expect(lines.some((line) => line.length === longHistoryLines)).toBeTruthy();
    expect(lines.some((line) => new Set(line).size < line.length)).toBeTruthy();
    expect(histories.some((history) => history?.includes('\r\n'))).toBeTruthy();

    const matching = new Set(full.labels.pairs.keys());

    expect(lines.some(matchesNothing(matching))).toBeTruthy();

    const mail = column(declarations.snapshot, full.rows, 'Mail');

    expect(mail).toContain(null);
    expect(mail).toContain('');
    expect(
      mail.every(
        (value) =>
          value === null || value === '' || String(value).endsWith('.example'),
      ),
    ).toBeTruthy();

    const names = column(declarations.snapshot, full.rows, 'Name').join('\n');
    for (const script of scripts) {
      expect(script.test(names)).toBeTruthy();
    }
  });

  it('carries both instance ids, either one or none, each unique in its column', () => {
    const [oldIds, newIds] = declarations.snapshot.instanceIds.map((field) =>
      column(declarations.snapshot, full.rows, field),
    );
    const combinations = new Set(
      (oldIds ?? []).map(
        (old, index) => `${old === null}/${newIds?.[index] === null}`,
      ),
    );

    expect(combinations.size).toBe(4);

    for (const ids of [oldIds, newIds]) {
      const present = (ids ?? []).filter((id) => id !== null);

      expect(new Set(present).size).toBe(present.length);
    }
  });

  it('keeps every bounded column within its 255 characters', () => {
    for (const field of declarations.snapshot.bounded) {
      const values = column(declarations.snapshot, full.rows, field);

      expect(
        values.every(
          (value) => typeof value !== 'string' || value.length <= 255,
        ),
      ).toBeTruthy();
    }
  });

  it('writes the header in the declared set, reversed', () => {
    const { fields } = declarations.snapshot;

    expect(csvOrder(fields)).toEqual(
      snapshotFields.map((_, index) => snapshotFields.length - 1 - index),
    );
    expect(csvHeader(fields)).toBe(
      `${[...snapshotFields].toReversed().join(',')}\n`,
    );
  });

  it('gives a test-only scraper column a place in the header and a value in every row', () => {
    const extra = 'Phone_new';
    const declaration = {
      ...declarations.snapshot,
      bounded: [...declarations.snapshot.bounded, extra],
      fields: [...declarations.snapshot.fields, extra],
    };
    const small = fixtureRows(declaration, {
      courses: 4,
      labels: 40,
      users: 120,
    });

    expect(csvHeader(declaration.fields).split(',', 1)[0]).toBe(extra);
    expect(
      small.rows.every((row) => row.length === declaration.fields.length),
    ).toBeTruthy();

    const values = column(declaration, small.rows, extra);

    expect(
      values.filter((value) => typeof value === 'string').length,
    ).toBeGreaterThan(100);
  });
});

describe('the years, generations and programs follow the model and the created rows', () => {
  it('publishes the model years and adds one newer unpublished year', () => {
    const rows = yearRows(declarations.years);

    expect(
      rows.filter(({ published }) => published).map(({ label }) => label),
    ).toEqual([...academicYears]);

    const extra = rows.at(-1);

    expect(extra?.published).toBe(false);
    expect(extra?.label).toBe('2026/2027');
    expect(new Set(rows.map(({ sort }) => sort)).size).toBe(rows.length);
    expect(Math.max(...rows.map(({ sort }) => sort))).toBe(extra?.sort);
  });

  it('follows a test-only model year into the rows and the history labels', () => {
    const years = ['2026/2027', ...declarations.years];
    const rows = yearRows(years);

    expect(rows).toHaveLength(academicYears.length + 2);
    expect(rows.at(-1)?.label).toBe('2027/2028');

    const { pairs } = stressLabels(
      courseNames(3),
      rows.map(({ label }) => label),
      200,
    );

    expect(
      pairs
        .keys()
        .filter((label) => label.endsWith('-2026/2027'))
        .toArray(),
    ).toHaveLength(3);
  });

  it('plans entries, states and links of a test-only generation from its rows', () => {
    const courses = courseNames(10).map((name, index) => ({
      id: 100 + index,
      name,
    }));
    const generations = [
      { code: '2013', has_curriculum: false, id: 1 },
      { code: '2028', has_curriculum: true, id: 9 },
    ];
    const programs = [
      { generation: 9, id: 91, sort: 2 },
      { generation: 9, id: 92, sort: 1 },
    ];
    const plan = curriculumPlan(generations, programs, courses);

    expect(plan).toHaveLength(8);
    expect(new Set(plan.map(({ entry }) => entry['generation']))).toEqual(
      new Set([9]),
    );

    const programsOfStates = new Set(
      plan.flatMap(({ states }) => states).map(({ program }) => program),
    );

    expect(programsOfStates).toEqual(new Set([91, 92]));
    expect(plan[0]?.states.map(({ program }) => program)).toEqual([92, 91]);
    expect(
      plan.every(({ course, link }) => link['course'] === course),
    ).toBeTruthy();
  });

  it('seeds the declared generations and programs', () => {
    const plan = curriculumPlan(
      declarations.generations.map(({ code, has_curriculum }, id) => ({
        code,
        has_curriculum,
        id,
      })),
      [],
      courseNames(5).map((name, id) => ({ id, name })),
    );
    const withCurriculum = declarations.generations.filter(
      ({ has_curriculum }) => has_curriculum,
    ).length;

    expect(plan).toHaveLength(withCurriculum * 4);
    expect(declarations.programs.length).toBeGreaterThan(0);
  });
});

describe('the expected files follow the export registry', () => {
  const coursesDefinition = declarations.definitions.find(
    ({ filename }) => filename === 'courses.json',
  );

  it('expects one file per declared definition, with its declared keys', () => {
    const files = expectedFiles(declarations.definitions, {});

    expect(files.map(({ filename }) => filename)).toEqual(
      declarations.definitions.map(({ filename }) => filename),
    );
    expect(files.every(({ keys }) => keys.length > 0)).toBeTruthy();
  });

  it('expects a test-only published file', () => {
    const extra: ExportDefinition = {
      fields: [{ key: 'label', rule: 'text', value: 'label' }],
      filename: 'years.json',
      maxBytes: 1_024,
      orderBy: 'id',
      related: {},
      rows: {
        collection: 'academic_years',
        fields: ['id', 'label'],
        sort: ['id'],
      },
    };
    const files = expectedFiles([...declarations.definitions, extra], {});

    expect(files.at(-1)).toEqual({ filename: 'years.json', keys: ['label'] });
  });

  it('expects exactly the keys of a published test-only generation and its programs', () => {
    expect(coursesDefinition).toBeDefined();

    if (coursesDefinition === undefined) return;
    const years = yearRows(declarations.years)
      .filter(({ published }) => published)
      .map(({ label, sort }, id) => ({ id, label, sort }));
    const before = expectedFiles([coursesDefinition], {
      published_years: years,
    })[0]?.keys;
    const after = expectedFiles([coursesDefinition], {
      published_generations: [{ code: '2028', id: 9, sort: 4 }],
      published_programs: [
        { code: 'cd', generation: 9, id: 92, sort: 1 },
        { code: 'ab', generation: 9, id: 91, sort: 2 },
      ],
      published_years: years,
    })[0]?.keys;

    expect(after?.filter((key) => !before?.includes(key))).toEqual([
      '2028-available',
      '2028-name',
      '2028-code',
      '2028-level',
      '2028-semester',
      '2028-channel',
      '2028-prerequisite',
      '2028-state-cd',
      '2028-state-ab',
      '2028-credits',
    ]);
    expect(
      before?.filter((key) => academicYears.includes(key as never)),
    ).toEqual([...academicYears]);
  });

  it('writes the rows of every other exported collection from its model fields', () => {
    const collections = referenceCollections(declarations.definitions);

    expect(collections).toEqual(
      declarations.definitions
        .map(({ rows }) => rows.collection)
        .filter((collection) => collection !== 'courses'),
    );

    for (const collection of collections) {
      const rows = modelRows(collection, 12);

      expect(rows).toHaveLength(12);
      expect(rows.every((row) => Object.keys(row).length > 0)).toBeTruthy();
    }
  });
});

describe('the oracle counts with each declared rule mode', () => {
  it('counts a pattern once per user and a mapping once per distinct user', () => {
    const lines = [
      ['A Course-2024/2025', 'A Course-2024/2025'],
      ['B Course-2024/2025', 'A Course-2024/2025'],
      ['A Course-2025/2026'],
      null,
    ];
    const histories = [
      'A Course-2024/2025\nA Course-2024/2025',
      'B Course-2024/2025\r\nA Course-2024/2025',
      'A Course-2025/2026',
      null,
    ];
    const counts = expectedCounts(
      { histories, lines },
      {
        mappings: [
          { course: 1, label: 'A Course-2025/2026', year: 1 },
          { course: 1, label: 'B Course-2024/2025', year: 1 },
        ],
        rules: [
          { course: 0, mode: legacy, pattern: 'A Course-2024/2025', year: 0 },
          { course: 0, mode: legacy, pattern: 'Course-202[45]', year: 1 },
          { course: 1, mode: mapped, pattern: null, year: 1 },
          { course: 2, mode: mapped, pattern: null, year: 1 },
        ],
      },
    );

    expect(Object.fromEntries(counts)).toEqual({
      [pairKey(0, 0)]: 2,
      [pairKey(0, 1)]: 3,
      [pairKey(1, 1)]: 2,
      [pairKey(2, 1)]: 0,
    });
  });

  it('refuses a rule of an undeclared mode', () => {
    expect(() =>
      expectedCounts(
        { histories: [], lines: [] },
        {
          mappings: [],
          rules: [{ course: 0, mode: 'manual_count', pattern: null, year: 0 }],
        },
      ),
    ).toThrow('No rule mode manual_count is declared');
  });
});
