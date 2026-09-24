import type { DirectusRequest } from '../directus-request.js';

import { chunk, createRows } from './batches.js';
import { readGenerationIds, readProgramIds } from './curriculum-reads.js';
import {
  convertGenerations,
  convertPrograms,
  type ProgramSeed,
} from './generations.js';
import { convertAcademicYears } from './rules.js';
import { readYearIds } from './target-reads.js';

// The rows the one-time import seeds from the workbook before the
// relational conversion's blocker gate: its academic years, curriculum
// generations and study programs, so a blocked import keeps them for
// `npm run migrate` to finish.

// The workbook's academic years were not all seeded: `npm run migrate`
// converts only the years a project holds, so it cannot finish this
// import, which has to start over.
export class YearSeedError extends Error {
  public override readonly name = 'YearSeedError';
}

// Seeds the workbook's academic years (published, sorted by column group)
// that the project lacks, in bounded batches, and answers how many it
// created. The rules step then finds them in place.
export const seedYears = async (
  request: DirectusRequest,
  academicYears: readonly string[],
  batchSize: number,
): Promise<number> => {
  try {
    const { writes } = convertAcademicYears(
      academicYears,
      await readYearIds(request),
    );
    for (const batch of chunk(writes, batchSize)) {
      await createRows(request, {
        collection: 'academic_years',
        fields: ['label'],
        records: batch.map(({ record }) => record),
      });
    }
    return writes.length;
  } catch (error) {
    throw new YearSeedError(
      `The academic years of the workbook were not all seeded: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
};

type Seed = {
  readonly collection: string;
  readonly fields: readonly string[];
  readonly records: ReadonlyArray<Readonly<Record<string, unknown>>>;
};

// Creates the rows of a seed in bounded batches; answers how many.
const createSeed = async (
  request: DirectusRequest,
  { collection, fields, records }: Seed,
  batchSize: number,
): Promise<number> => {
  for (const batch of chunk(records, batchSize)) {
    await createRows(request, { collection, fields, records: batch });
  }
  return records.length;
};

// Seeds the workbook's generations (2013 label-only and unpublished, 2018
// and 2023 published with a curriculum) and the study programs its
// curriculum sheets head their program columns with, whichever the
// project lacks, as the curricula step would; answers how many rows it
// created per collection. A failure here leaves the import for npm run
// migrate to finish: its curricula step seeds the same rows.
export const seedCurriculum = async (
  request: DirectusRequest,
  programs: readonly ProgramSeed[],
  batchSize: number,
): Promise<Readonly<Record<string, number>>> => {
  const generations = await createSeed(
    request,
    {
      collection: 'curriculum_generations',
      fields: ['code'],
      records: convertGenerations(await readGenerationIds(request)).writes.map(
        ({ record }) => record,
      ),
    },
    batchSize,
  );
  const { writes } = convertPrograms(programs, {
    generations: await readGenerationIds(request),
    programs: await readProgramIds(request),
  });
  const studyPrograms = await createSeed(
    request,
    {
      collection: 'study_programs',
      fields: ['generation', 'code'],
      records: writes.map(({ record }) => record),
    },
    batchSize,
  );
  return {
    ...(generations > 0 && { curriculum_generations: generations }),
    ...(studyPrograms > 0 && { study_programs: studyPrograms }),
  };
};
