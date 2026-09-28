import { describe, expect, test } from 'vitest';

import { courses as coursesDefinition } from '../directus/extensions/directus-extension-data-operations/src/exports/courses.js';
import { fileKeys } from '../directus/extensions/directus-extension-data-operations/src/exports/engine.js';
import { exportDefinitions } from '../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import {
  specProgramHeaders,
  workbookPrograms,
} from '../src/migrations/generations.js';
import { academicYears } from '../src/specs/public.js';
import { expectedFiles, expectedKeys } from './expected-exports.js';
import {
  forbiddenPrivateFields,
  makeSyntheticDataset,
} from './fixtures/synthetic-data.js';
import { storeFromDataset } from './migration-test-helpers.js';
import {
  injecting,
  publishedFiles,
  storeReader,
} from './relational-export-helpers.js';

// The public contract of the files beside the committed checkpoint files
// (test/fixtures/expected-exports): the directories the export engine
// publishes from the synthetic rows, and the keys and their order the
// courses definition resolves from published years, generations and
// programs.

// The files read from their own collection alone: rooms, staff and
// students. The synthetic course rows carry the curriculum ambiguities the
// conversion refuses, so courses.json is proven over the parity dataset
// (relational-export.test.ts).
const directoryDefinitions = exportDefinitions.filter(
  ({ filename }) => filename !== 'courses.json',
);

describe('the synthetic directories through the export engine', () => {
  test('publish exactly the committed synthetic rooms, staff and students, private columns on every row or not', async () => {
    const reader = storeReader(storeFromDataset(makeSyntheticDataset()));
    const { rooms, staff, students } = await expectedFiles('synthetic');

    for (const read of [reader, injecting(reader, forbiddenPrivateFields)]) {
      await expect(publishedFiles(directoryDefinitions, read)).resolves.toEqual(
        { rooms, staff, students },
      );
    }
  });
});

// The keys of the committed courses.json, in output order.
const referenceKeys = await expectedKeys('courses');

// The academic_years rows of the fifteen checkpoint years as the published
// key source reads them (published, oldest sorting 1), in reverse order to
// show the engine orders them itself.
const checkpointYears: readonly string[] = academicYears;

const publishedYearRows = (labels: readonly string[] = checkpointYears) =>
  labels
    .map((label) => ({
      id: 100 + checkpointYears.indexOf(label),
      label,
      sort: checkpointYears.length - checkpointYears.indexOf(label),
    }))
    .toReversed();

// The generation and program rows the one-time import seeds, as the
// published key sources read them: 2023 and 2018 published with their
// curriculum-sheet programs (2013 is label-only and unpublished, so the
// sources never read it), in reverse order to show the engine orders
// them itself.
const generationRows = [
  { code: '2018', id: 2, sort: 2 },
  { code: '2023', id: 3, sort: 3 },
];

const programRows = workbookPrograms(specProgramHeaders)
  .map(({ code, generation, sort }, index) => ({
    code,
    generation: generation === '2023' ? 3 : 2,
    id: 10 + index,
    sort,
  }))
  .toReversed();

const curriculumKeyRows = {
  published_generations: generationRows.toReversed(),
  published_programs: programRows,
};

describe('published-year keys of the relational courses definition', () => {
  test('fill exactly the reference year positions with the fifteen published years', () => {
    expect(
      fileKeys(coursesDefinition, {
        keyRows: {
          ...curriculumKeyRows,
          published_years: publishedYearRows(),
        },
      }),
    ).toEqual(referenceKeys);
  });

  test('leave out an unpublished year and nothing else', () => {
    const published = academicYears.filter((year) => year !== '2019/2020');

    expect(
      fileKeys(coursesDefinition, {
        keyRows: {
          ...curriculumKeyRows,
          published_years: publishedYearRows(published),
        },
      }),
    ).toEqual(referenceKeys.filter((label) => label !== '2019/2020'));
  });

  test('list the newer label first when two published years share a sort', () => {
    const keys = fileKeys(coursesDefinition, {
      keyRows: {
        published_years: [
          { id: 1, label: '2024/2025', sort: 2 },
          { id: 2, label: '2025/2026', sort: 2 },
          { id: 3, label: '2023/2024', sort: 1 },
        ],
      },
    });

    expect(keys.filter((key) => key.includes('/'))).toEqual([
      '2025/2026',
      '2024/2025',
      '2023/2024',
    ]);
  });

  test('place a newly published later year first among the year keys', () => {
    const keys = fileKeys(coursesDefinition, {
      keyRows: {
        ...curriculumKeyRows,
        published_years: [
          ...publishedYearRows(),
          { id: 99, label: '2026/2027', sort: 16 },
        ],
      },
    });
    const reference = referenceKeys;

    expect(keys).toEqual([
      ...reference.slice(0, 2),
      '2026/2027',
      ...reference.slice(2),
    ]);
  });
});

// The courses keys over the given generation and program rows.
const keysWith = (
  generations: ReadonlyArray<Readonly<Record<string, unknown>>>,
  programs: ReadonlyArray<Readonly<Record<string, unknown>>>,
) =>
  fileKeys(coursesDefinition, {
    keyRows: {
      published_generations: generations,
      published_programs: programs,
      published_years: publishedYearRows(),
    },
  });

describe('generation keys of the relational courses definition', () => {
  test("reproduce the 15 state keys in each generation's declared layout", () => {
    const keys = keysWith(generationRows, programRows);

    expect(keys).toEqual(referenceKeys);
    expect(keys.filter((key) => key.includes('-state-'))).toHaveLength(15);
  });

  test('add a newly published generation with two published programs with no code change', () => {
    const keys = keysWith(
      [...generationRows, { code: '2028', id: 4, sort: 4 }],
      [
        ...programRows,
        { code: 'ab', generation: 4, id: 91, sort: 2 },
        { code: 'cd', generation: 4, id: 92, sort: 1 },
      ],
    );
    const reference = referenceKeys;
    const assistants = reference.indexOf('assistants') + 1;

    expect(keys).toEqual([
      ...reference.slice(0, reference.indexOf('2023-available')),
      '2028-available',
      ...reference.slice(reference.indexOf('2023-available'), assistants),
      '2028-name',
      '2028-code',
      '2028-level',
      '2028-semester',
      '2028-channel',
      '2028-prerequisite',
      '2028-state-cd',
      '2028-state-ab',
      '2028-credits',
      ...reference.slice(assistants),
    ]);
  });

  test.each(['constructor', 'toString', '__proto__'])(
    'follow the default layout for a published generation coded %s, a name every object inherits',
    (code) => {
      const keys = keysWith(
        [...generationRows, { code, id: 4, sort: 4 }],
        [...programRows, { code: 'ab', generation: 4, id: 91, sort: 1 }],
      );

      expect(keys.filter((key) => key.startsWith(`${code}-`))).toEqual(
        [
          'available',
          'name',
          'code',
          'level',
          'semester',
          'channel',
          'prerequisite',
          'state-ab',
          'credits',
        ].map((suffix) => `${code}-${suffix}`),
      );
    },
  );

  test('add no state key for a program the sources did not read (unpublished)', () => {
    const keys = keysWith(
      generationRows,
      programRows.filter(
        ({ code, generation }) => !(code === 'ie' && generation === 3),
      ),
    );

    expect(keys).toEqual(
      referenceKeys.filter((key) => key !== '2023-state-ie'),
    );
  });
});
