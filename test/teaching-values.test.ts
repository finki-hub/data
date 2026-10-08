import { describe, expect, test } from 'vitest';

import {
  assignmentRoles,
  assistantsText,
  type CourseStatus,
  courseStatuses,
  labelSeparator,
  professorsText,
  teachingTexts,
} from '../directus/extensions/directus-extension-data-operations/src/exports/teaching-values.js';
import { findField } from './data-model-test-helpers.js';

// The teaching values courses.json publishes, declared once: what each
// status publishes as professors and assistants, from the staff names of
// its links in drag order.

const first = 'Synthetic Staff One';
const second = 'Synthetic Staff Two';

const allProfessors = 'Сите професори';
const inactive = '(неактивиран предмет)';

type Row = {
  readonly assistants: null | string;
  readonly names: readonly string[];
  readonly professors: null | string;
  readonly status: CourseStatus;
};

// Each status with no name, one name and two names out of id order: the
// texts given the same names as professor names and as assistant names.
const table: readonly Row[] = [
  { assistants: null, names: [], professors: null, status: 'active' },
  { assistants: first, names: [first], professors: first, status: 'active' },
  {
    assistants: `${second}\n${first}`,
    names: [second, first],
    professors: `${second}\n${first}`,
    status: 'active',
  },
  {
    assistants: null,
    names: [],
    professors: allProfessors,
    status: 'all_professors',
  },
  {
    assistants: first,
    names: [first],
    professors: allProfessors,
    status: 'all_professors',
  },
  {
    assistants: `${second}\n${first}`,
    names: [second, first],
    professors: allProfessors,
    status: 'all_professors',
  },
  { assistants: inactive, names: [], professors: inactive, status: 'inactive' },
  {
    assistants: inactive,
    names: [first],
    professors: inactive,
    status: 'inactive',
  },
  {
    assistants: inactive,
    names: [second, first],
    professors: inactive,
    status: 'inactive',
  },
];

// The stored values of a model enum, its default and whether it may be
// empty.
const valuesOf = (collection: string, field: string) => {
  const found = findField(collection, field);
  return found.kind === 'enum'
    ? {
        defaultValue: found.defaultValue,
        nullable: found.nullable,
        values: found.choices.map(({ value }) => value),
      }
    : null;
};

describe('the teaching values', () => {
  test('declare the statuses, roles, status texts and separator once', () => {
    expect(courseStatuses).toEqual(['active', 'all_professors', 'inactive']);
    expect(assignmentRoles).toEqual(['professor', 'assistant']);
    expect(teachingTexts).toEqual({ allProfessors, inactive });
    expect(labelSeparator).toBe('\n');
  });

  test('give the model its course status and staff roles, a course starting Active', () => {
    expect(valuesOf('courses', 'status')).toEqual({
      defaultValue: 'active',
      nullable: false,
      values: [...courseStatuses],
    });
    expect(valuesOf('teaching_assignments', 'role')?.values).toEqual([
      ...assignmentRoles,
    ]);
  });

  test.each(table)(
    '$status with $names.length names publishes the decided texts',
    ({ assistants, names, professors, status }) => {
      expect({
        assistants: assistantsText(status, names),
        professors: professorsText(status, names),
      }).toEqual({ assistants, professors });
    },
  );

  test('the table covers every status', () => {
    expect(new Set(table.map(({ status }) => status))).toEqual(
      new Set(courseStatuses),
    );
  });
});
