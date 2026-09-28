import type {
  MigrationItem,
  ModelCollectionKey,
  WorkbookKey,
} from '../schema.js';
import type { Candidates } from './candidates.js';

import { findModelCollection } from '../data-model/collections.js';
import { uniqueMatch } from './labels.js';
import {
  planned,
  type PlannedRecord,
  type PlannedRow,
  ref,
} from './planned.js';

// The workbook columns a content row carries into its collection: every
// column the model declares for it, as the workbook holds it. A column
// the model adds later is copied as soon as the workbook part reads it.
const copied = (
  collection: ModelCollectionKey,
  item: MigrationItem,
): PlannedRecord =>
  Object.fromEntries(
    (findModelCollection(collection)?.fields ?? []).flatMap(
      ({ field, kind }) =>
        kind !== 'm2o' && Object.hasOwn(item, field)
          ? [[field, item[field] ?? null]]
          : [],
    ),
  );

// One row per workbook row, keyed by its ordinal, carrying the copied
// columns and the links the check decided (none by default).
export const contentRows = (
  {
    collection,
    source,
  }: {
    readonly collection: ModelCollectionKey;
    readonly source: WorkbookKey;
  },
  items: readonly MigrationItem[],
  links: (id: number) => PlannedRecord = () => ({}),
): readonly PlannedRow[] =>
  items.map((item, index) =>
    planned(
      index + 1,
      { ...copied(collection, item), ...links(index + 1) },
      { id: index + 1, source },
    ),
  );

// The course of an equivalency row, when its 2023 label names exactly
// one course.
export const equivalencyLinks =
  (candidates: Candidates['equivalencies']) =>
  (id: number): PlannedRecord => {
    const link = candidates.find((candidate) => candidate.id === id);
    const course = link === undefined ? null : uniqueMatch(link.course);
    return { course: course === null ? null : ref('courses', course) };
  };

// The student of a council row, when exactly one student carries its
// index; the index labels an unlinked member.
export const councilLinks =
  (candidates: Candidates['council']) =>
  (id: number): PlannedRecord => {
    const member = candidates.find((candidate) => candidate.id === id);
    const student = member === undefined ? null : uniqueMatch(member.student);
    return { student: student === null ? null : ref('students', student) };
  };
