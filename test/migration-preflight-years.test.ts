import { describe, expect, test } from 'vitest';

import type { MigrationReport } from '../src/migrations/report.js';

import { readInventory } from '../src/migrations/inventory.js';
import { preflight } from '../src/migrations/preflight.js';
import { academicYears } from '../src/specs/public.js';
import {
  courseNames,
  makeSyntheticDataset,
  type SyntheticDataset,
} from './fixtures/synthetic-data.js';
import {
  fakeItemsDirectus,
  storeFromDataset,
} from './migration-test-helpers.js';

const laterYear = '2026/2027';

// The synthetic dataset with a pattern row of the later year for Beta.
const withLaterPattern = (): SyntheticDataset => {
  const base = makeSyntheticDataset();
  return {
    ...base,
    course_enrollment_patterns: [
      ...base.course_enrollment_patterns,
      {
        academic_year: laterYear,
        course_name: courseNames.beta,
        id: 90,
        pattern: 'Synthetic Later Beta Line',
      },
    ],
  };
};

// The preflight of a populated checkpoint holding the dataset (and the
// given academic_years rows), over the given years (the years the project
// holds when none are named).
const reportFor = async (
  dataset: SyntheticDataset,
  years?: readonly string[],
  yearRows: ReadonlyArray<{ readonly id: number; readonly label: string }> = [],
): Promise<MigrationReport> => {
  const store = storeFromDataset(dataset, { installed: true });
  store.items.set(
    'academic_years',
    yearRows.map((row) => ({ ...row })),
  );
  const inventory = await readInventory(fakeItemsDirectus(store).request, {});
  return years === undefined
    ? preflight(inventory, null)
    : preflight(inventory, null, years);
};

const betaYears = (report: MigrationReport): readonly string[] =>
  report.candidates.courses
    .find(({ name }) => name === courseNames.beta)
    ?.rules.map(({ academicYear }) => academicYear) ?? [];

const unknownYears = (report: MigrationReport) =>
  report.warnings
    .filter(({ code }) => code === 'unknown_academic_year')
    .map(({ ids }) => ids);

describe('the academic years the conversion seeds', () => {
  test('default to the fifteen years the checkpoint counts, newest first', async () => {
    const report = await reportFor(makeSyntheticDataset());

    expect(report.academicYears).toEqual([...academicYears]);
    expect(betaYears(report)).toEqual([...academicYears]);
  });

  test('seed a rule per course for every year the workbook names and keep its pattern rows', async () => {
    const years = [laterYear, ...academicYears];
    const report = await reportFor(withLaterPattern(), years);
    const beta = report.candidates.courses.find(
      ({ name }) => name === courseNames.beta,
    );

    expect(report.academicYears).toEqual(years);
    expect(betaYears(report)).toEqual(years);
    expect(beta?.rules[0]).toMatchObject({
      pattern: 'Synthetic Later Beta Line',
      source: 'override',
    });
    expect(unknownYears(report)).toEqual([]);
    expect(
      report.mappings.filter(
        ({ sourceCollection }) => sourceCollection === 'academic_years',
      ),
    ).toHaveLength(16);
  });

  test('keep a year the conversion does not seed as an unknown-year finding', async () => {
    const report = await reportFor(withLaterPattern());

    expect(unknownYears(report)).toEqual([[90]]);
  });

  test('default to every year the project holds, so an upgrade finishing a blocked import keeps its later year', async () => {
    const seeded = [laterYear, ...academicYears].map((label, index) => ({
      id: index + 1,
      label,
    }));
    const report = await reportFor(
      withLaterPattern(),
      undefined,
      seeded.toReversed(),
    );

    expect(report.academicYears).toEqual([laterYear, ...academicYears]);
    expect(betaYears(report)).toEqual([laterYear, ...academicYears]);
    expect(unknownYears(report)).toEqual([]);
    expect(
      report.mappings
        .filter(({ sourceCollection }) => sourceCollection === 'academic_years')
        .map(({ targetId }) => targetId)
        .toSorted((left, right) => Number(left) - Number(right)),
    ).toEqual(seeded.map(({ id }) => id));
  });

  test('keep every checkpoint year when the project holds only a later one', async () => {
    const report = await reportFor(withLaterPattern(), undefined, [
      { id: 7, label: laterYear },
    ]);

    expect(report.academicYears).toEqual([laterYear, ...academicYears]);
    expect(unknownYears(report)).toEqual([]);
  });
});
