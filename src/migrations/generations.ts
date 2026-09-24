import type { FieldSpec } from '../schema.js';

import { referenceCollectionSpecs } from '../specs/reference.js';
import {
  Collector,
  compositeKey,
  type Conversion,
  ConverterError,
  existing,
  pending,
} from './converter-types.js';

// What the historical workbook knows about curriculum generations and
// study programs, closed and in this adapter only: its three generations
// and the Cyrillic headers of its curriculum sheets' program columns. The
// one-time conversion seeds rows from it; afterwards the rows are
// administrator data and nothing here grows with them.

export type EntrySource = 'curriculum_2018' | 'curriculum_2023';

export type GenerationRecord = {
  readonly code: string;
  readonly has_curriculum: boolean;
  readonly label: string;
  readonly published: boolean;
  readonly sort: number;
};

type WorkbookGeneration = GenerationRecord & {
  // The checkpoint column of its equivalency label.
  readonly equivalencyColumn: 'course_2013' | 'course_2018' | 'course_2023';
  // Its curriculum sheet, or null for a label-only generation.
  readonly sheet: EntrySource | null;
};

// The generations of the workbook, oldest first: 2018 and 2023 carry a
// curriculum sheet and are published as today's courses.json publishes
// them; 2013 names equivalency labels only.
export const workbookGenerations: readonly WorkbookGeneration[] = [
  {
    code: '2013',
    equivalencyColumn: 'course_2013',
    has_curriculum: false,
    label: 'Curriculum 2013',
    published: false,
    sheet: null,
    sort: 1,
  },
  {
    code: '2018',
    equivalencyColumn: 'course_2018',
    has_curriculum: true,
    label: 'Curriculum 2018',
    published: true,
    sheet: 'curriculum_2018',
    sort: 2,
  },
  {
    code: '2023',
    equivalencyColumn: 'course_2023',
    has_curriculum: true,
    label: 'Curriculum 2023',
    published: true,
    sheet: 'curriculum_2023',
    sort: 3,
  },
];

export const generationOfSheet = (sheet: EntrySource): string => {
  const generation = workbookGenerations.find((row) => row.sheet === sheet);
  if (generation === undefined) {
    throw new ConverterError(`No generation reads the sheet ${sheet}.`);
  }
  return generation.code;
};

// A curriculum sheet heads a program column with a header outside the
// closed mapping, or with another program's header: the import fails
// before anything is written (the workbook reader reports it as a
// workbook data error).
export class ProgramHeaderError extends Error {
  public override readonly name = 'ProgramHeaderError';
}

// The closed mapping of a curriculum sheet's program header to the code of
// its study program. A header outside it fails the import.
export const programCodes: Readonly<Record<string, string>> = {
  SEIS: 'seis',
  ИЕ: 'ie',
  ИМБ: 'imb',
  КЕ: 'ke',
  КИ: 'ki',
  КН: 'kn',
  ПИТ: 'pit',
  СИИС: 'siis',
  ССП: 'ssp',
};

const statePrefix = 'state_';

// The program columns of a curriculum sheet as the checkpoint spec reads
// them: its state fields in sheet column order.
export const stateColumns = (
  sheet: EntrySource,
): ReadonlyArray<{ readonly column: number; readonly target: string }> => {
  const spec = referenceCollectionSpecs.find(({ key }) => key === sheet);
  const fields: readonly FieldSpec[] = spec?.fields ?? [];
  return fields
    .flatMap(({ sourceColumn, target }) =>
      target.startsWith(statePrefix) && sourceColumn !== undefined
        ? [{ column: sourceColumn, target }]
        : [],
    )
    .toSorted((left, right) => left.column - right.column);
};

// The program headers of each curriculum sheet, in column order.
export type ProgramHeaders = Readonly<Record<EntrySource, readonly string[]>>;

export type ProgramSeed = {
  readonly code: string;
  readonly generation: string;
  readonly name: string;
  readonly sort: number;
};

const sheets: readonly EntrySource[] = ['curriculum_2023', 'curriculum_2018'];

// The study programs of the workbook: each program column's header mapped
// through the closed mapping, named by the header and sorted by column.
// An unknown header, or one heading a column the import reads as another
// program, fails the import before anything is written.
export const workbookPrograms = (
  headers: ProgramHeaders,
): readonly ProgramSeed[] =>
  sheets.flatMap((sheet) =>
    stateColumns(sheet).map(({ target }, index) => {
      const header = headers[sheet][index] ?? '';
      const code = programCodes[header];
      if (code === undefined || `${statePrefix}${code}` !== target) {
        throw new ProgramHeaderError(
          `The program column ${String(index + 1)} of the ${sheet} sheet is headed ${JSON.stringify(header.slice(0, 40))}, but the import reads it as ${target.slice(statePrefix.length).toUpperCase()}; only the headers ${Object.keys(programCodes).join(', ')} are known, in the checkpoint column order.`,
        );
      }
      return {
        code,
        generation: generationOfSheet(sheet),
        name: header,
        sort: index + 1,
      };
    }),
  );

const specHeaders = (sheet: EntrySource): readonly string[] => {
  const spec = referenceCollectionSpecs.find(({ key }) => key === sheet);
  const fields: readonly FieldSpec[] = spec?.fields ?? [];
  return stateColumns(sheet).map(
    ({ target }) =>
      fields.find((field) => field.target === target)?.source ?? '',
  );
};

// The headers the checkpoint spec describes, for a project converted
// without its workbook (the populated upgrade path).
export const specProgramHeaders: ProgramHeaders = {
  curriculum_2018: specHeaders('curriculum_2018'),
  curriculum_2023: specHeaders('curriculum_2023'),
};

const generationCollection = 'curriculum_generations';
const programCollection = 'study_programs';

// The three workbook generations the project lacks; a code already present
// is reused as it is.
export const convertGenerations = (
  present: ReadonlyMap<string, number>,
): Conversion<GenerationRecord> => {
  const out = new Collector<GenerationRecord>();
  for (const generation of workbookGenerations) {
    const { code, has_curriculum, label, published, sort } = generation;
    const source = {
      collection: generationCollection,
      id: code,
      relation: 'code',
    };
    const id = present.get(code);
    if (id === undefined) {
      out.write({ code, has_curriculum, label, published, sort }, [
        pending(source, generationCollection),
      ]);
    } else {
      out.settle(existing(source, generationCollection, id));
    }
  }
  return out.result();
};

export type ProgramRecord = {
  readonly code: string;
  readonly generation: number;
  readonly name: string;
  readonly published: boolean;
  readonly sort: number;
};

export const programKey = (generation: number | string, code: string) =>
  compositeKey(generation, code);

// The workbook's programs, published, one per generation and code; a
// program already present is reused as it is.
export const convertPrograms = (
  seeds: readonly ProgramSeed[],
  ids: {
    readonly generations: ReadonlyMap<string, number>;
    readonly programs: ReadonlyMap<string, number>;
  },
): Conversion<ProgramRecord> => {
  const out = new Collector<ProgramRecord>();
  for (const seed of seeds) {
    const generation = ids.generations.get(seed.generation);
    if (generation === undefined) {
      throw new ConverterError(
        `The generation ${seed.generation} of program ${seed.code} was not created before its programs.`,
      );
    }
    const source = {
      collection: programCollection,
      id: `${seed.generation}/${seed.code}`,
      relation: 'code',
    };
    const id = ids.programs.get(programKey(generation, seed.code));
    if (id === undefined) {
      out.write(
        {
          code: seed.code,
          generation,
          name: seed.name,
          published: true,
          sort: seed.sort,
        },
        [pending(source, programCollection)],
      );
    } else {
      out.settle(existing(source, programCollection, id));
    }
  }
  return out.result();
};
