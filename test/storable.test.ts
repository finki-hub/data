import { describe, expect, test } from 'vitest';

import type { ModelCollectionKey } from '../src/schema.js';

import { courseStatuses } from '../directus/extensions/directus-extension-data-operations/src/exports/teaching-values.js';
import { refusalLines } from '../src/import-report.js';
import { planImport } from '../src/import/plan.js';
import {
  planned,
  type PlannedCollection,
  type PlannedRecord,
  type PlannedValue,
  ref,
} from '../src/import/planned.js';
import { unstorableValues } from '../src/import/storable.js';
import { contentOf } from './import-plan-helpers.js';
import { parityDataset } from './relational-export-helpers.js';

// What the columns of one planned row cannot hold, by field.
const problemsOf = (collection: ModelCollectionKey, record: PlannedRecord) =>
  unstorableValues([{ collection, rows: [planned(1, record)] }]).map(
    ({ field, problem }) => ({ field, problem }),
  );

const course = (status: PlannedValue): PlannedRecord => ({
  name: 'Synthetic Course',
  status,
});

const staffMember = (position: string): PlannedRecord => ({
  active: true,
  email: 'synthetic@staff.example',
  name: 'Synthetic Staff',
  position,
  title: 'Synthetic title',
});

const outside = [{ field: 'status', problem: 'outside declared choices' }];

// The planned collections with the first course's status replaced: no
// workbook cell plans a closed value outside its choices today.
const withFirstStatus = (
  collections: readonly PlannedCollection[],
  status: string,
): readonly PlannedCollection[] =>
  collections.map((entry) =>
    entry.collection === 'courses'
      ? {
          ...entry,
          rows: entry.rows.map((row, index) =>
            index === 0 ? { ...row, record: { ...row.record, status } } : row,
          ),
        }
      : entry,
  );

describe('enum values the import plans', () => {
  test('refuse a closed value outside the declared choices', () => {
    expect(problemsOf('courses', course('deferred'))).toEqual(outside);
    expect(problemsOf('courses', course('Active'))).toEqual(outside);
    expect(problemsOf('courses', course(1))).toEqual(outside);
  });

  test('accept every declared choice of a closed enum', () => {
    expect(
      courseStatuses.flatMap((status) => problemsOf('courses', course(status))),
    ).toEqual([]);
  });

  test('accept an allow-other value outside the choices up to 255 characters', () => {
    expect(problemsOf('staff', staffMember('Synthetic Position'))).toEqual([]);
    expect(problemsOf('staff', staffMember('x'.repeat(255)))).toEqual([]);
    expect(problemsOf('staff', staffMember('🎓'.repeat(255)))).toEqual([]);
    expect(problemsOf('staff', staffMember('x'.repeat(256)))).toEqual([
      { field: 'position', problem: '256 characters, max 255' },
    ]);
    expect(
      problemsOf('curriculum_entry_program_states', {
        entry: ref('curriculum_entries', 1),
        program: ref('study_programs', 1),
        state: null,
      }),
    ).toEqual([]);
  });

  test('are placed by sheet, row and field, never quoted', () => {
    const base = parityDataset();
    const long = 'Synthetic position '.repeat(14);
    const content = contentOf({
      ...base,
      staff: base.staff.map((row, index) =>
        index === 1 ? { ...row, position: long } : row,
      ),
    });
    const plan = planImport(content);
    const lines = refusalLines(
      {
        ...plan,
        unstorable: unstorableValues(
          withFirstStatus(plan.collections, 'deferred'),
        ),
      },
      content,
    );

    expect(lines).toEqual([
      '- [unstorable] Кадар (Export) row 3, staff.position: 266 characters, max 255',
      '- [unstorable] Предмети (Export) row 2, courses.status: outside declared choices',
    ]);
    expect(lines.join('\n')).not.toContain('deferred');
    expect(lines.join('\n')).not.toContain('Synthetic position');
  });
});
