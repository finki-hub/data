import type { FieldSpec } from '../schema.js';

import { referenceWorkbookSpecs } from '../specs/reference.js';
import { compositeKey, planned, type PlannedRow, ref } from './planned.js';

// What the historical workbook knows about curriculum generations and
// study programs, closed and in the import only: its three generations
// and the Cyrillic headers of its curriculum sheets' program columns. The
// one-time import seeds rows from it; afterwards the rows are
// administrator data and nothing here grows with them.

export type EntrySource = 'curriculum_2018' | 'curriculum_2023';

type WorkbookGeneration = {
  readonly code: '2013' | '2018' | '2023';
  // The equivalency sheet column of its label.
  readonly equivalencyColumn: 'course_2013' | 'course_2018' | 'course_2023';
  readonly has_curriculum: boolean;
  readonly label: string;
  readonly published: boolean;
  // Its curriculum sheet, or null for a label-only generation.
  readonly sheet: EntrySource | null;
  readonly sort: number;
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

// The generation code of a curriculum sheet.
export const generationOfSheet = (sheet: EntrySource): string => {
  const generation = workbookGenerations.find((row) => row.sheet === sheet);
  if (generation === undefined) {
    throw new TypeError(`No workbook generation reads the sheet ${sheet}.`);
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

// The program columns of a curriculum sheet as its workbook spec reads
// them: its state fields in sheet column order.
export const stateColumns = (
  sheet: EntrySource,
): ReadonlyArray<{ readonly column: number; readonly target: string }> => {
  const spec = referenceWorkbookSpecs.find(({ key }) => key === sheet);
  const fields: readonly FieldSpec[] = spec?.fields ?? [];
  return fields
    .flatMap(({ sourceColumn, target }) =>
      target.startsWith(statePrefix) && sourceColumn !== undefined
        ? [{ column: sourceColumn, target }]
        : [],
    )
    .toSorted((left, right) => left.column - right.column);
};

// The program code a state column holds the states of.
export const programOfColumn = (target: string): string =>
  target.slice(statePrefix.length);

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
      if (code === undefined || code !== programOfColumn(target)) {
        throw new ProgramHeaderError(
          `The program column ${String(index + 1)} of the ${sheet} sheet is headed ${JSON.stringify(header.slice(0, 40))}, but the import reads it as ${programOfColumn(target).toUpperCase()}; only the headers ${Object.keys(programCodes).join(', ')} are known, in the column order of the workbook.`,
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

export const programKey = (generation: string, code: string): string =>
  compositeKey(generation, code);

// The three workbook generations.
export const planGenerations = (): readonly PlannedRow[] =>
  workbookGenerations.map(({ code, has_curriculum, label, published, sort }) =>
    planned(code, { code, has_curriculum, label, published, sort }),
  );

// The workbook's programs, published, one per generation and code.
export const planPrograms = (
  seeds: readonly ProgramSeed[],
): readonly PlannedRow[] =>
  seeds.map((seed) =>
    planned(programKey(seed.generation, seed.code), {
      code: seed.code,
      generation: ref('curriculum_generations', seed.generation),
      name: seed.name,
      published: true,
      sort: seed.sort,
    }),
  );
