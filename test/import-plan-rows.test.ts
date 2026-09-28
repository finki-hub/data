import { describe, expect, test } from 'vitest';

import { labelSeparator } from '../directus/extensions/directus-extension-data-operations/src/exports/course-values.js';
import { staffListSeparator } from '../src/migrations/preflight-staff.js';
import { findField } from './data-model-test-helpers.js';
import {
  courseNames,
  type SyntheticDataset,
} from './fixtures/synthetic-data.js';
import {
  planOf,
  rowsIn,
  shapes,
  uniqueDataset,
  withAssignment,
  withStaff,
} from './import-plan-helpers.js';

const alphaAssistants = 'Asst. Alpha One; Asst. Alpha Two';
const mixedProfessors = 'Prof. One, Prof. Two; Prof. Three';
const twin = 'Prof. Twin';
const thetaProfessor = 'Prof. Theta';

// A ninth teaching row, of Delta, whose professors text is given.
const withDeltaProfessors = (
  dataset: SyntheticDataset,
  professors: string,
): SyntheticDataset =>
  withAssignment(dataset, {
    id: 9,
    course_name: courseNames.delta,
    professors,
    assistants: null,
  });

// The role rows the plan writes for the teaching row of the ordinal, and
// the findings on it.
const roleRowsOf = (dataset: SyntheticDataset, ordinal: number) => {
  const plan = planOf(dataset);
  return {
    findings: [...plan.blockers, ...plan.warnings].filter(
      ({ collection, ids }) =>
        collection === 'teaching_assignments' && ids.includes(ordinal),
    ),
    rows: rowsIn(plan, 'teaching_assignments')
      .filter(({ origin }) => origin?.id === ordinal)
      .map(({ record }) => record),
  };
};

describe('teaching assignments: staff links', () => {
  test('links complete labels of a list joined exactly by ", " to one staff row each, in the order the text names them', () => {
    const dataset = withStaff(uniqueDataset(), [
      'Prof. Abe Alpha',
      'Prof. Zed Alpha',
      'Asst. Alpha One',
      'Asst. Alpha Two',
      thetaProfessor,
    ]);
    const staffAt = (name: string) =>
      dataset.staff.findIndex((row) => row['name'] === name) + 1;

    // The assistants use "; ": linked, the export would republish them
    // joined by ", ", so the text stays one literal review row.
    expect(
      roleRowsOf(dataset, 1).rows.map(
        ({ display_override, role, sort, staff }) => ({
          display_override,
          role,
          sort,
          staff,
        }),
      ),
    ).toEqual([
      {
        display_override: null,
        role: 'professor',
        sort: 1,
        staff: { collection: 'staff', key: String(staffAt('Prof. Zed Alpha')) },
      },
      {
        display_override: null,
        role: 'professor',
        sort: 2,
        staff: { collection: 'staff', key: String(staffAt('Prof. Abe Alpha')) },
      },
      {
        display_override: alphaAssistants,
        role: 'assistant',
        sort: 1,
        staff: null,
      },
    ]);
    expect(roleRowsOf(dataset, 6).rows[0]).toMatchObject({
      display_override: null,
      staff: { collection: 'staff', key: String(staffAt(thetaProfessor)) },
    });
    expect(staffListSeparator).toBe(labelSeparator);
  });

  test.each([
    ['a "; " list', 'Prof. One; Prof. Two'],
    ['a ";" list', 'Prof. One;Prof. Two'],
    ['a line-break list', 'Prof. One\nProf. Two'],
    ['a "," list', 'Prof. One,Prof. Two'],
    ['a list with a padded part', 'Prof. One,  Prof. Two'],
    ['a list with a padded delimiter', 'Prof. One , Prof. Two'],
    ['a padded list', ' Prof. One, Prof. Two'],
    ['a padded label', 'Prof. One '],
  ])(
    'keeps %s literal although every part names one staff row',
    (_label, text) => {
      const dataset = withDeltaProfessors(
        withStaff(uniqueDataset(), ['Prof. One', 'Prof. Two']),
        text,
      );
      const { findings, rows } = roleRowsOf(dataset, 8);

      expect(rows).toEqual([
        expect.objectContaining({
          display_override: text,
          role: 'professor',
          sort: 1,
          staff: null,
        }),
      ]);
      expect(findings.map(({ code }) => code)).toEqual([
        'unresolved_staff_text',
      ]);
    },
  );

  test('keeps a list repeating a label, mixed delimiters or a label several staff rows carry as review text', () => {
    const repeated = `${thetaProfessor}, ${thetaProfessor}`;
    const cases = [
      [withStaff(uniqueDataset(), [thetaProfessor]), repeated],
      [
        withStaff(uniqueDataset(), ['Prof. One', 'Prof. Two', 'Prof. Three']),
        mixedProfessors,
      ],
      [withStaff(uniqueDataset(), [twin, twin]), twin],
    ] as const;

    for (const [dataset, text] of cases) {
      expect(
        roleRowsOf(withDeltaProfessors(dataset, text), 8).rows.map(
          ({ display_override, staff }) => [display_override, staff],
        ),
      ).toEqual([[text, null]]);
    }

    expect(
      shapes(
        roleRowsOf(withDeltaProfessors(cases[2][0], twin), 8).findings,
        'ambiguous_staff_label',
      ),
    ).toEqual([{ collection: 'teaching_assignments', ids: [8] }]);
  });

  test('plans an unresolved text longer than a short string verbatim, which the model column can hold', () => {
    const long = Array.from(
      { length: 40 },
      (_, index) => `Prof. Synthetic ${String(index)}`,
    ).join(' & ');

    expect(long.length).toBeGreaterThan(255);
    expect(
      roleRowsOf(withDeltaProfessors(uniqueDataset(), long), 8).rows,
    ).toEqual([
      expect.objectContaining({ display_override: long, staff: null }),
    ]);
    expect(findField('teaching_assignments', 'display_override').kind).toBe(
      'text',
    );
  });
});
