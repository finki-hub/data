import type {
  ModelCollectionKey,
  WorkbookItem,
  WorkbookKey,
} from '../schema.js';
import type { Candidates } from './candidates.js';

import { findModelCollection } from '../data-model/collections.js';
import { linkedRow } from './labels.js';
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
  item: WorkbookItem,
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
  items: readonly WorkbookItem[],
  links: (id: number) => PlannedRecord = () => ({}),
): readonly PlannedRow[] =>
  items.map((item, index) =>
    planned(
      index + 1,
      { ...copied(collection, item), ...links(index + 1) },
      { id: index + 1, source },
    ),
  );

// The teaching status of a course row, decided from its teaching cells,
// and its Discord channel: the first channel row naming it, or none.
export const courseLinks = ({
  channels,
  courses,
}: Pick<Candidates, 'channels' | 'courses'>) => {
  const statuses = new Map(
    courses.map(({ id, teaching }) => [id, teaching.status]),
  );
  const linked = new Map(
    channels.map(({ channel, course }) => [course, channel]),
  );
  return (id: number): PlannedRecord => {
    const channel = linked.get(id);
    return {
      discord_channel:
        channel === undefined ? null : ref('discord_channels', channel),
      status: statuses.get(id) ?? null,
    };
  };
};

// The course of an equivalency row, when its 2023 label names exactly
// one course.
export const equivalencyLinks =
  (candidates: Candidates['equivalencies']) =>
  (id: number): PlannedRecord => {
    const link = candidates.find((candidate) => candidate.id === id);
    const course = link === undefined ? null : linkedRow(link.course);
    return { course: course === null ? null : ref('courses', course) };
  };

// The student of a council row, when exactly one student carries its
// index; the index labels an unlinked member.
export const councilLinks =
  (candidates: Candidates['council']) =>
  (id: number): PlannedRecord => {
    const member = candidates.find((candidate) => candidate.id === id);
    const student = member === undefined ? null : linkedRow(member.student);
    return { student: student === null ? null : ref('students', student) };
  };

// The dean's office terms: every Деканат row with its year, position and
// the staff row its name links, and no name. A row that links no staff
// row is not planned; its blocker refuses the import (dean-links.ts).
export const deanTerms = (
  items: readonly WorkbookItem[],
  deans: Candidates['deans'],
): readonly PlannedRow[] => {
  const holders = new Map(deans.map(({ id, staff }) => [id, staff]));
  return contentRows(
    { collection: 'deans_office', source: 'deans_office' },
    items,
    (id) => {
      const staff = holders.get(id);
      return staff === undefined ? {} : { staff: ref('staff', staff) };
    },
  ).filter(({ key }) => holders.has(Number(key)));
};
