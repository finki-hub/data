import { z } from 'zod';

import type { DirectusRequest } from '../directus-request.js';
import type { EquivalencyLinks } from './equivalencies.js';

import { roleKey } from './assignments.js';
import { compositeKey } from './converter-types.js';
import { type ExistingLink, linkKey } from './course-links.js';
import { entryKey } from './curricula.js';
import { readAll } from './paging.js';
import { type ExistingRule, ruleKey } from './rules.js';

// The target state a converter step reads fresh when it starts, keyed the
// way the converters look rows up. Reading at step time, not from the
// inventory taken before the ledger began, means a resumed step sees the
// rows an interrupted attempt already wrote and a later step sees the rows
// an earlier step created in the same run.

const id = z.number().int();
const text = z.string().nullable();
const integer = z.number().int().nullable();

type RowSchema = z.ZodObject & z.ZodType<{ readonly id: number }>;

type Listing<S extends RowSchema> = {
  readonly collection: string;
  readonly schema: S;
};

// Every row of a collection with exactly the schema's fields, indexed by
// the entries the caller derives from each row.
const indexed = async <S extends RowSchema, K, V>(
  request: DirectusRequest,
  { collection, schema }: Listing<S>,
  entries: (row: z.output<S>) => ReadonlyArray<readonly [K, V]>,
): Promise<ReadonlyMap<K, V>> => {
  const rows = await readAll(request, {
    fields: Object.keys(schema.shape),
    pathname: `/items/${collection}`,
    schema,
  });
  return new Map(rows.flatMap((row) => entries(row)));
};

const provenanceRow = z.object({
  id,
  source_collection: text,
  source_id: integer,
});

const entrySources: ReadonlySet<string> = new Set([
  'curriculum_2018',
  'curriculum_2023',
]);

export const readEntryIds = (
  request: DirectusRequest,
): Promise<ReadonlyMap<string, number>> =>
  indexed(
    request,
    { collection: 'curriculum_entries', schema: provenanceRow },
    (row) =>
      row.source_collection !== null &&
      entrySources.has(row.source_collection) &&
      row.source_id !== null
        ? [[entryKey(row.source_collection, row.source_id), row.id]]
        : [],
  );

const linkRow = z.object({
  course: integer,
  entry: integer,
  generation: text,
  id,
});

// Links keyed by course and generation, with the entry each one points at
// so a link set by hand to another entry is recognised, not adopted.
export const readCourseLinks = (
  request: DirectusRequest,
): Promise<ReadonlyMap<string, ExistingLink>> =>
  indexed(
    request,
    { collection: 'course_curricula', schema: linkRow },
    (row) =>
      row.course === null || row.generation === null
        ? []
        : [
            [
              linkKey(row.course, row.generation),
              { entry: row.entry, id: row.id },
            ],
          ],
  );

const yearRow = z.object({ id, label: text });

export const readYearIds = (
  request: DirectusRequest,
): Promise<ReadonlyMap<string, number>> =>
  indexed(request, { collection: 'academic_years', schema: yearRow }, (row) =>
    row.label === null ? [] : [[row.label, row.id]],
  );

const ruleRow = z.object({
  academic_year: integer,
  course: integer,
  id,
  mode: text,
  pattern: text,
});

// Rules keyed by course and year label, as the converter plans them, with
// the mode and pattern each one carries so a rule edited or created by
// hand is recognised, not adopted.
export const readRules = (
  request: DirectusRequest,
  yearIds: ReadonlyMap<string, number>,
): Promise<ReadonlyMap<string, ExistingRule>> => {
  const labels = new Map(
    yearIds.entries().map(([label, year]) => [year, label]),
  );
  return indexed(
    request,
    { collection: 'course_enrollment_rules', schema: ruleRow },
    (row) => {
      const label =
        row.academic_year === null ? undefined : labels.get(row.academic_year);
      return row.course === null || label === undefined
        ? []
        : [
            [
              ruleKey(row.course, label),
              { id: row.id, mode: row.mode, pattern: row.pattern },
            ],
          ];
    },
  );
};

const roleRow = z.object({
  id,
  role: text,
  source_collection: text,
  source_id: integer,
});

// The role-bearing rows an earlier attempt created, told apart from the
// original text rows by their provenance and grouped per source row and
// role in ascending id order. The pair is the unit of idempotency: every
// row of a pair is written in one batch, and nothing an editor may change
// afterwards (the sort, the staff, the label) takes part in the key.
export const readRoleRows = async (
  request: DirectusRequest,
): Promise<ReadonlyMap<string, readonly number[]>> => {
  const rows = await readAll(request, {
    fields: Object.keys(roleRow.shape),
    pathname: '/items/teaching_assignments',
    schema: roleRow,
  });
  const keyed = rows.flatMap((row) =>
    row.source_collection === 'teaching_assignments' &&
    row.source_id !== null &&
    row.role !== null
      ? [{ id: row.id, key: roleKey(row.source_id, row.role) }]
      : [],
  );
  return new Map(
    Map.groupBy(keyed, ({ key }) => key)
      .entries()
      .map(([key, items]) => [
        key,
        items.map(({ id: rowId }) => rowId).toSorted((a, b) => a - b),
      ]),
  );
};

const councilRow = z.object({ id, student: integer });

export const readCouncilLinks = (
  request: DirectusRequest,
): Promise<ReadonlyMap<number, null | number>> =>
  indexed(
    request,
    { collection: 'student_council', schema: councilRow },
    (row) => [[row.id, row.student]],
  );

const equivalencyRow = z.object({
  course: integer,
  entry_2018: integer,
  entry_2023: integer,
  id,
});

export const readEquivalencyLinks = (
  request: DirectusRequest,
): Promise<ReadonlyMap<number, EquivalencyLinks>> =>
  indexed(
    request,
    { collection: 'course_equivalencies', schema: equivalencyRow },
    (row) => [
      [
        row.id,
        {
          course: row.course,
          entry_2018: row.entry_2018,
          entry_2023: row.entry_2023,
        },
      ],
    ],
  );

// Keys created rows by the columns read back after a POST, so a plan is
// matched to its row by content rather than by position.
export const createdKey = (
  row: Readonly<Record<string, unknown>>,
  columns: readonly string[],
): string => compositeKey(...columns.map((column) => String(row[column])));
