import {
  defaultMaxBytes,
  type ExportDefinition,
  type FieldEntry,
  type Resolver,
} from './types.js';
import { pathValue, textOf } from './values.js';

// bachelor_theses.json and master_theses.json: one row per thesis in id
// order, as the faculty lists it. A mentor or committee member is
// published by their staff name (as staff.json has it) when the name the
// thesis gives matched a staff member, else as the thesis writes it.
// title is required: a consumer reads it on every row.

// The person a name column of the thesis stands for: the staff name of the
// staff row the import derived from that written name, else the name as
// written.
export const personOf =
  (column: string): Resolver =>
  ({ related, row }) => {
    const written = textOf(row[column]);
    if (written === null) {
      return null;
    }
    const match = (related['staff'] ?? []).find(
      (link) => link['name'] === written,
    );
    return (
      (match === undefined ? null : textOf(pathValue(match, 'staff.name'))) ??
      written
    );
  };

const text = (key: string, value: string = key): FieldEntry => ({
  key,
  rule: 'text',
  value,
});

type ThesisFile = {
  readonly collection: 'bachelor_theses' | 'master_theses';
  readonly committee: 'bachelor_thesis_staff' | 'master_thesis_staff';
  // The day key, then the name columns in order.
  readonly date: string;
  readonly people: readonly string[];
};

const thesisFile = (file: ThesisFile): ExportDefinition => ({
  fields: [
    { key: 'title', required: true, rule: 'text', value: 'title' },
    text('description'),
    text('student_index'),
    text('student_name'),
    text('status'),
    text(file.date),
    text('file_id'),
    ...file.people.map((column): FieldEntry => ({
      key: column,
      rule: 'text',
      value: personOf(column),
    })),
  ],
  filename: `${file.collection}.json`,
  maxBytes: defaultMaxBytes,
  orderBy: 'id',
  related: {
    staff: {
      by: 'thesis',
      collection: file.committee,
      fields: ['id', 'thesis', 'name', 'staff.name'],
      sort: ['id'],
    },
  },
  rows: {
    collection: file.collection,
    fields: [
      'id',
      'title',
      'description',
      'student_index',
      'student_name',
      'status',
      file.date,
      'file_id',
      ...file.people,
    ],
    sort: ['id'],
  },
});

export const bachelorTheses = thesisFile({
  collection: 'bachelor_theses',
  committee: 'bachelor_thesis_staff',
  date: 'submitted',
  people: ['mentor', 'member_1', 'member_2'],
});

export const masterTheses = thesisFile({
  collection: 'master_theses',
  committee: 'master_thesis_staff',
  date: 'presented',
  people: ['mentor', 'president', 'member'],
});
