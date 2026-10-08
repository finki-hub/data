import type {
  ExportDefinition,
  KeySourceName,
  Row,
} from '../../directus/extensions/directus-extension-data-operations/src/exports/types.js';
import type {
  ModelCollectionKey,
  ModelField,
  Scalar,
} from '../../src/schema.js';

import { fileKeys } from '../../directus/extensions/directus-extension-data-operations/src/exports/file-check.js';
import { exportDefinitions } from '../../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { findModelCollection } from '../../src/data-model/collections.js';
import {
  type ProgramSeed,
  workbookGenerations,
} from '../../src/import/generations.js';
import {
  declaredSnapshot,
  type SnapshotDeclaration,
} from './stress-snapshot.js';
import { academicYears } from './synthetic-data.js';
import { syntheticPrograms } from './synthetic-workbook.js';

// The reference side of the generated stress fixture, built from the
// declarations rather than from copied lists: the academic years of the
// model plus one newer year that stays unpublished, the curriculum
// generations and study programs the one-time import seeds (created as
// rows; everything below them is derived from the created rows), the
// source rows of every exported collection from its model fields, and the
// expected files from the export registry. A new year, generation,
// program or published file therefore changes the fixture without an
// edit here; test/stress-fixture.test.ts proves it with test-only
// declarations.

type GenerationSeed = {
  readonly code: string;
  readonly has_curriculum: boolean;
  readonly label: string;
  readonly published: boolean;
  readonly sort: number;
};

type Declarations = {
  readonly definitions: readonly ExportDefinition[];
  readonly generations: readonly GenerationSeed[];
  readonly programs: readonly ProgramSeed[];
  readonly snapshot: SnapshotDeclaration;
  readonly years: readonly string[];
};

export const declarations: Declarations = {
  definitions: exportDefinitions,
  generations: workbookGenerations.map(
    ({ code, has_curriculum, label, published, sort }) => ({
      code,
      has_curriculum,
      label,
      published,
      sort,
    }),
  ),
  programs: syntheticPrograms,
  snapshot: declaredSnapshot,
  years: academicYears,
};

type YearRow = {
  readonly label: string;
  readonly published: boolean;
  readonly sort: number;
};

const yearPattern = /^(?<start>\d{4})\/(?<end>\d{4})$/u;

const yearParts = (label: string): readonly [number, number] => {
  const match = yearPattern.exec(label);
  const start = Number(match?.groups?.['start'] ?? NaN);
  const end = Number(match?.groups?.['end'] ?? NaN);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    throw new TypeError(`The academic year ${label} is not shaped YYYY/YYYY`);
  }
  return [start, end];
};

// The model's years, published, newest with the highest sort, and the
// year after the newest one, unpublished, sorted after them all.
export const yearRows = (years: readonly string[]): readonly YearRow[] => {
  if (years.length === 0) {
    throw new Error('The model declares no academic year');
  }
  let [start, end] = yearParts(years[0] ?? '');
  for (const label of years) {
    const parts = yearParts(label);
    if (parts[0] > start) [start, end] = parts;
  }
  return [
    ...years.map((label, index) => ({
      label,
      published: true,
      sort: years.length - index,
    })),
    {
      label: `${start + 1}/${end + 1}`,
      published: false,
      sort: years.length + 1,
    },
  ];
};

// The generation and program seeds as rows to create; every program is
// published, as the one-time import publishes them.
export const generationSeeds = (seeds: Declarations) => ({
  generations: seeds.generations,
  programs: seeds.programs.map((program) => ({ ...program, published: true })),
});

// The rows the fixture created, as the curriculum plan reads them.
type CreatedCourse = {
  readonly id: number;
  readonly name: string;
};
type CreatedGeneration = {
  readonly code: string;
  readonly has_curriculum: boolean;
  readonly id: number;
};
type CreatedProgram = {
  readonly generation: number;
  readonly id: number;
  readonly sort: number;
};

type PlannedEntry = {
  readonly course: number;
  readonly entry: Readonly<Record<string, Scalar>>;
  readonly link: Readonly<Record<string, Scalar>>;
  readonly states: ReadonlyArray<{
    readonly program: number;
    readonly state: string;
  }>;
};

const states = ['Задолжителен', 'Изборен', null] as const;

// One curriculum entry per course and generation with a curriculum (four
// courses in five get one), with a state per program of that generation
// (two in three programs) and the course's link; all from the created
// generation, program and course rows.
export const curriculumPlan = (
  generations: readonly CreatedGeneration[],
  programs: readonly CreatedProgram[],
  courses: readonly CreatedCourse[],
): readonly PlannedEntry[] =>
  generations
    .filter(({ has_curriculum }) => has_curriculum)
    .flatMap((generation, position) =>
      courses.flatMap((course, index) => {
        if ((index + position) % 5 === 4) return [];
        const own = programs
          .filter((program) => program.generation === generation.id)
          .toSorted((left, right) => left.sort - right.sort);
        return [
          {
            course: course.id,
            entry: {
              channel: index % 4 === 0,
              code: `SYN-${generation.code}-${String(index).padStart(4, '0')}`,
              generation: generation.id,
              level: 1 + (index % 3),
              name: `${course.name} (${generation.code})`,
              prerequisites: index % 6 === 0 ? 'Синтетички предуслов' : null,
              semester: 1 + (index % 8),
            },
            link: {
              available: index % 5 !== 0,
              course: course.id,
              credits: index % 7 === 0 ? null : 6,
              generation: generation.id,
              sort: position + 1,
            },
            states: own.flatMap((program, offset) => {
              const state = states[(index + offset) % states.length] ?? null;
              return state === null ? [] : [{ program: program.id, state }];
            }),
          },
        ];
      }),
    );

const fieldValue = (
  { field, kind, nullable }: ModelField,
  index: number,
): Scalar => {
  if (nullable && index % 6 === 5) return null;
  if (kind === 'boolean') return index % 3 !== 0;
  if (kind === 'integer') return index % 40;
  if (kind === 'text')
    return `Synthetic ${field} ${index}, Дизајн\nsecond line`;
  // A string field is a varchar(255) column; these stay far shorter.
  return field === 'email'
    ? `stress-${index}@staff.example`
    : `Синтетички ${field} ${index} "🏫"`;
};

// Rows of a model collection from its declared scalar fields, `count` of
// them.
export const modelRows = (
  collection: ModelCollectionKey,
  count: number,
): ReadonlyArray<Readonly<Record<string, Scalar>>> => {
  const model = findModelCollection(collection);
  if (model === undefined) {
    throw new Error(`The model declares no collection ${collection}`);
  }
  const fields = model.fields.filter(
    ({ kind }) => kind !== 'm2o' && kind !== 'enum',
  );
  return Array.from({ length: count }, (_, index) =>
    Object.fromEntries(
      fields.map((field) => [field.field, fieldValue(field, index)]),
    ),
  );
};

// The collections whose rows a published file reads besides the courses
// (whose rows the fixture writes itself, with the names the history labels
// use): every definition's main collection the model declares.
export const referenceCollections = (
  definitions: readonly ExportDefinition[],
): readonly ModelCollectionKey[] => [
  ...new Set(
    definitions.flatMap(({ rows }) => {
      const model = findModelCollection(rows.collection);
      return model === undefined || model.collection === 'courses'
        ? []
        : [model.collection];
    }),
  ),
];

// The published files and their keys for the key rows the created rows
// place (key source name → rows, as the key source reads them).
export const expectedFiles = (
  definitions: readonly ExportDefinition[],
  keyRows: Partial<Record<KeySourceName, readonly Row[]>>,
) =>
  definitions.map((definition) => ({
    filename: definition.filename,
    keys: fileKeys(definition, { keyRows }),
  }));
