import { describe, expect, test } from 'vitest';

import {
  checkSummary,
  refusalCount,
  refusalLines,
} from '../src/import-report.js';
import { planImport } from '../src/import/plan.js';
import { ref } from '../src/import/planned.js';
import { readWorkbookContent } from '../src/workbook.js';
import {
  staffNames,
  type SyntheticDataset,
  type SyntheticRow,
} from './fixtures/synthetic-data.js';
import { reloaded, syntheticWorkbook } from './fixtures/synthetic-workbook.js';
import {
  contentOf,
  planOf,
  recordsIn,
  rowsIn,
  staffRow,
} from './import-plan-helpers.js';
import { parityDataset } from './relational-export-helpers.js';

// The staff member of each dean's office term, linked by the import from
// the exact name of its Деканат row. In the parity dataset row 1 names the
// first staff row (Декан) and row 2 the third (Продекан за настава), both
// in 2024; contentOf places term N on Деканат row N + 1 and staff row N on
// Кадар (Export) row N + 1.

const nobody = 'Synthetic Staff Nobody';
const twin = 'Synthetic Staff Twin';

const term = (
  id: number,
  name: null | string,
  position: string,
): SyntheticRow => ({ id, name, position, year: 2_023 });

// A term of 2024, the year of the parity dataset's two terms.
const term2024 = (
  id: number,
  name: null | string,
  position: string,
): SyntheticRow => ({ ...term(id, name, position), year: 2_024 });

// The staff rows with two more that share one name.
const withTwins = (staff: readonly SyntheticRow[]): readonly SyntheticRow[] => [
  ...staff,
  staffRow(staff.length + 1, twin),
  staffRow(staff.length + 2, twin),
];

const withTerms = (
  dataset: SyntheticDataset,
  terms: readonly SyntheticRow[],
): SyntheticDataset => ({
  ...dataset,
  deans_office: [...dataset.deans_office, ...terms],
});

const linesOf = (dataset: SyntheticDataset): readonly string[] => {
  const content = contentOf(dataset);
  return refusalLines(planImport(content), content);
};

describe("the staff member of a dean's office term", () => {
  test('links each row to the staff row of its exact name and plans the year, position and link, never the name', () => {
    const plan = planOf(parityDataset());

    expect(refusalCount(plan)).toBe(0);
    expect(rowsIn(plan, 'deans_office').map(({ key }) => key)).toEqual([
      '1',
      '2',
    ]);
    expect(recordsIn(plan, 'deans_office')).toEqual([
      { position: 'Декан', staff: ref('staff', 1), year: 2_024 },
      {
        position: 'Продекан за настава',
        staff: ref('staff', 3),
        year: 2_024,
      },
    ]);
  });

  test('plans no row whose name no staff row or several carry, or that has no name, and refuses the import', () => {
    const dataset = {
      ...withTerms(parityDataset(), [
        term(3, nobody, 'Продекан за финансии'),
        term(4, twin, 'Продекан за наука и соработка'),
        // Exact names only: a trailing space matches no one.
        term(5, `${staffNames.active} `, 'Декан'),
        term(6, null, 'Продекан за настава'),
      ]),
      staff: withTwins(parityDataset().staff),
    };
    const plan = planOf(dataset);

    expect(rowsIn(plan, 'deans_office').map(({ key }) => key)).toEqual([
      '1',
      '2',
    ]);
    expect(
      plan.blockers.map(({ code, collection, ids }) => [code, collection, ids]),
    ).toEqual([
      ['ambiguous_staff_name', 'deans_office', [4]],
      ['invalid_source_row', 'deans_office', [6]],
      ['unmatched_staff_name', 'deans_office', [3]],
      ['unmatched_staff_name', 'deans_office', [5]],
    ]);
    // An unplanned row is a blocker only, never also an empty staff link.
    expect(plan.unstorable).toEqual([]);
    expect(checkSummary(plan, contentOf(dataset)).rows).toMatchObject({
      deans_office: 2,
    });
  });

  test('refuses a position outside the four, placed by its row and field', () => {
    const dataset = withTerms(parityDataset(), [
      term(3, staffNames.inactive, 'Dean'),
    ]);
    const plan = planOf(dataset);

    expect(plan.blockers).toEqual([]);
    expect(plan.unstorable).toEqual([
      {
        collection: 'deans_office',
        field: 'position',
        key: '3',
        origin: { id: 3, source: 'deans_office' },
        problem: 'outside declared choices',
      },
    ]);
    expect(linesOf(dataset)).toEqual([
      '- [unstorable] Деканат row 4, deans_office.position: outside declared choices',
    ]);
  });

  test('refuses a second holder of a year and position, whoever holds it', () => {
    const base = parityDataset();

    expect(
      linesOf(withTerms(base, [term2024(3, staffNames.inactive, 'Декан')])),
    ).toEqual([
      '- [duplicate_role_row] Деканат rows 2, 4: same year and position',
    ]);
    // The same person in another year or position holds another term.
    expect(
      linesOf(
        withTerms(base, [
          term(3, staffNames.active, 'Декан'),
          term2024(4, staffNames.active, 'Продекан за финансии'),
        ]),
      ),
    ).toEqual([]);
  });

  test('places a name by its cell, an empty one too, and names the staff rows it matches, never a staff value', () => {
    const base = parityDataset();
    const dataset = {
      ...withTerms(base, [
        term(3, nobody, 'Продекан за финансии'),
        term(4, twin, 'Продекан за наука и соработка'),
        term(5, null, 'Декан'),
      ]),
      staff: withTwins(base.staff),
    };
    const lines = linesOf(dataset);
    // The two twins follow the staff rows below the header.
    const twins = [base.staff.length + 2, base.staff.length + 3].join(', ');

    expect(lines).toEqual([
      `- [ambiguous_staff_name] Деканат row 5, column "Име": matches Кадар (Export) rows ${twins}`,
      '- [invalid_source_row] Деканат row 6, column "Име": missing required value',
      '- [unmatched_staff_name] Деканат row 4, column "Име": not found in Кадар (Export)',
    ]);

    const text = lines.join('\n');
    for (const value of [
      nobody,
      twin,
      ...dataset.staff.flatMap((row) => [row['name'], row['email']]),
    ]) {
      expect(typeof value === 'string' && text.includes(value)).toBe(false);
    }
  });

  test('reads the Деканат sheet of a written workbook into the same terms', async () => {
    const dataset = parityDataset();
    const content = readWorkbookContent(
      await reloaded(syntheticWorkbook(dataset)),
    );

    expect(recordsIn(planImport(content), 'deans_office')).toEqual(
      recordsIn(planOf(dataset), 'deans_office'),
    );
  });
});
