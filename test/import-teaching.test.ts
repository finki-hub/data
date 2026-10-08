import { describe, expect, test } from 'vitest';

import { checkSummary, refusalLines } from '../src/import-report.js';
import { planImport } from '../src/import/plan.js';
import {
  courseNames,
  staffNames,
  type SyntheticDataset,
} from './fixtures/synthetic-data.js';
import { lifecycleDataset } from './fixtures/synthetic-workbook.js';
import {
  codes,
  contentOf,
  planOf,
  rowsIn,
  shapes,
  staffRow,
  withAssignment,
  withCourse,
  withTeaching,
} from './import-plan-helpers.js';
import { parityDataset } from './relational-export-helpers.js';

// The refusal lines of a dataset, as the import reads it in dataset order.
const linesOf = (dataset: SyntheticDataset): readonly string[] => {
  const content = contentOf(dataset);
  return refusalLines(planImport(content), content);
};

const twin = 'Synthetic Staff Twin';
const nobody = 'Synthetic Staff Nobody';

// The parity dataset (Наставен Кадар rows 2 to 9 in dataset order, Кадар
// (Export) rows 2 to 8) with two staff rows sharing a name (rows 9, 10).
const withTwins = (): SyntheticDataset => {
  const base = parityDataset();
  return {
    ...base,
    staff: [...base.staff, staffRow(8, twin), staffRow(9, twin)],
  };
};

describe('teaching cells the import refuses', () => {
  test('name the cell, the course and the lines of each name no staff row or several carry, never a staff value', () => {
    const theta = withTeaching(withTwins(), courseNames.theta, {
      assistants: `${twin}\n${staffNames.inactive}\n${twin}`,
      professors: `${staffNames.minimal}\n${nobody} One\n${staffNames.active}\n${nobody} Two`,
    });
    const dataset = withCourse(
      withTeaching(theta, courseNames.zeta, { assistants: twin }),
      courseNames.gamma,
      { typed_professors: `${nobody} Typed` },
    );
    const lines = linesOf(dataset);

    expect(lines).toEqual([
      '- [ambiguous_staff_name] Наставен Кадар row 5, column "Асистенти" «Zeta Course»: line 1 matches Кадар (Export) rows 9, 10',
      '- [ambiguous_staff_name] Наставен Кадар row 7, column "Асистенти" «Theta Course»: lines 1, 3 match Кадар (Export) rows 9, 10',
      '- [unmatched_staff_name] Предмети (Export) row 4, column "professors" «Gamma Course»: line 1 not found in Кадар (Export)',
      '- [unmatched_staff_name] Наставен Кадар row 7, column "Професори" «Theta Course»: lines 2, 4 not found in Кадар (Export)',
    ]);

    for (const value of [twin, nobody, ...Object.values(staffNames)]) {
      expect(lines.join('\n')).not.toContain(value);
    }
  });

  test('name the assistants cell of an Inactive course that names anyone', () => {
    const dataset = withTeaching(parityDataset(), courseNames.delta, {
      assistants: staffNames.minimal,
    });

    expect(linesOf(dataset)).toEqual([
      '- [inactive_course_assistants] Наставен Кадар row 9 «Delta Course»: column "Асистенти" not empty for «(неактивиран предмет)»',
    ]);
    expect(rowsIn(planOf(dataset), 'teaching_assignments')).toHaveLength(
      rowsIn(planOf(parityDataset()), 'teaching_assignments').length,
    );
  });

  // The professors texts the committed files once republished verbatim
  // for Alpha, whose two names are staff rows of the parity dataset.
  test.each([
    ['Prof. Zed Alpha, Prof. Abe Alpha', 'unmatched_staff_name'],
    ['Prof. Zed Alpha; Prof. Abe Alpha', 'unmatched_staff_name'],
    ['Prof. Zed Alpha;Prof. Abe Alpha', 'unmatched_staff_name'],
    ['Prof. Zed Alpha\nProf. Abe Alpha', null],
    ['Prof. Zed Alpha,Prof. Abe Alpha', 'unmatched_staff_name'],
    ['Prof. Zed Alpha ,  Prof. Abe Alpha', 'unmatched_staff_name'],
    [' Prof. Zed Alpha, Prof. Abe Alpha', 'unmatched_staff_name'],
    ['Prof. Zed Alpha ', 'unmatched_staff_name'],
  ])(
    'reads the professors text %j one staff name per line: %s',
    (professors, blocker) => {
      const plan = planOf(
        withTeaching(parityDataset(), courseNames.alpha, { professors }),
      );
      const alphaProfessors = rowsIn(plan, 'teaching_assignments')
        .filter(({ key }) => key.startsWith('1\u{0}'))
        .filter(({ record }) => record['role'] === 'professor')
        .map(({ record }) => record['staff']);

      expect(shapes(plan.blockers, 'unmatched_staff_name')).toEqual(
        blocker === null
          ? []
          : [{ collection: 'teaching_assignments', ids: [1] }],
      );
      expect(codes(plan.blockers)).toEqual(blocker === null ? [] : [blocker]);
      expect(alphaProfessors).toEqual(
        blocker === null
          ? [
              { collection: 'staff', key: '4' },
              { collection: 'staff', key: '5' },
            ]
          : [],
      );
    },
  );
});

describe('an export row with typed professors', () => {
  test('wins: its teaching rows are skipped unread, so names no staff row carries there block nothing', () => {
    // Beta's two teaching rows name nobody of the staff.
    const dataset = withAssignment(lifecycleDataset(), {
      id: 10,
      course_name: courseNames.beta,
      professors: `${nobody} Later`,
      assistants: null,
    });
    const plan = planOf(dataset);

    expect(plan.blockers).toEqual([]);
    expect(shapes(plan.skipped, 'superseded_assignment')).toEqual([
      { collection: 'teaching_assignments', ids: [3] },
      { collection: 'teaching_assignments', ids: [4] },
      { collection: 'teaching_assignments', ids: [10] },
    ]);
    // No row of Beta is a later row of a course that uses one.
    expect(
      shapes(plan.warnings, 'duplicate_assignment').map(({ ids }) => ids),
    ).toEqual([[2]]);
    expect(
      rowsIn(plan, 'teaching_assignments')
        .filter(({ key }) => key.startsWith('2\u{0}'))
        .map(({ origin, record }) => [origin, record['staff']]),
    ).toEqual([
      [
        { id: 2, source: 'courses' },
        { collection: 'staff', key: '1' },
      ],
    ]);
  });

  test('places a name it lists again by its cell and line under fixes', () => {
    const dataset = withCourse(lifecycleDataset(), courseNames.gamma, {
      typed_professors: `${staffNames.minimal}\n${staffNames.minimal}`,
    });

    expect(checkSummary(planOf(dataset), contentOf(dataset)).fixes).toEqual({
      duplicate_assignment: ['Наставен Кадар row 3 (used: row 2)'],
      repeated_staff_name: [
        'Предмети (Export) row 4, column "professors", line 2',
        'Наставен Кадар row 9, column "Професори", line 3',
      ],
    });
  });
});
