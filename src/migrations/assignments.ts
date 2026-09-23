import type { AssignmentRow } from './inventory-schemas.js';
import type { Candidates, StaffCandidate } from './report.js';

import { ConverterWriteError } from './batches.js';
import {
  Collector,
  compositeKey,
  type Conversion,
  ConverterError,
  existing,
  pending,
  unresolved,
} from './converter-types.js';
import { finding, type LabelIndex, listIds, quote } from './labels.js';
import { staffListSeparator } from './preflight-staff.js';

// A role-bearing assignment row: one per staff member a text names when
// every complete label matches exactly one staff row, or one review row
// carrying the literal text when it does not. The original text row is
// never modified; `course_name` repeats its label because the checkpoint
// column is NOT NULL, and the professor/assistant columns stay empty so the
// checkpoint derivation (first ascending id per course name) never sees a
// new row before the original.
export type RoleRowRecord = {
  readonly assistants: null;
  readonly course: number;
  readonly course_name: string;
  readonly display_override: null | string;
  readonly professors: null;
  readonly role: StaffCandidate['role'];
  readonly sort: number;
  readonly source_collection: 'teaching_assignments';
  readonly source_id: number;
  readonly staff: null | number;
};

// The unit of idempotency: the rows one text of one source row produced.
// They are written in one batch and recognised by provenance and role only,
// so a sort, staff or label an editor changes afterwards never makes a
// resumed run write the pair again.
export const roleKey = (sourceId: number | string, role: string) =>
  compositeKey(sourceId, role);

const collection = 'teaching_assignments';

export type AssignmentInput = {
  readonly candidates: Candidates['assignments'];
  // Role rows already present per (source_id, role), ascending ids.
  readonly existing: ReadonlyMap<string, readonly number[]>;
  readonly rows: readonly AssignmentRow[];
  readonly staffByName: LabelIndex;
};

type Context = {
  readonly course: number;
  readonly label: string;
  readonly row: AssignmentRow;
};

type Values = Pick<RoleRowRecord, 'display_override' | 'staff'>;

const sourceOf = (row: AssignmentRow, role: string, sort: number) => ({
  collection,
  id: row.id,
  relation: `role:${role}:${String(sort)}`,
});

// Writes the rows of one pair, or settles the rows already present for it.
type Pair = {
  readonly context: Context;
  readonly role: StaffCandidate['role'];
  readonly values: readonly Values[];
};

const emitPair = (
  out: Collector<RoleRowRecord>,
  input: AssignmentInput,
  { context, role, values }: Pair,
): void => {
  const present = input.existing.get(roleKey(context.row.id, role));
  if (present !== undefined) {
    for (const [index, id] of present.entries()) {
      out.settle(
        existing(sourceOf(context.row, role, index + 1), collection, id),
      );
    }
    return;
  }
  for (const [index, value] of values.entries()) {
    const sort = index + 1;
    out.write(
      {
        ...value,
        assistants: null,
        course: context.course,
        course_name: context.label,
        professors: null,
        role,
        sort,
        source_collection: collection,
        source_id: context.row.id,
      },
      [pending(sourceOf(context.row, role, sort), collection)],
    );
  }
};

// A text resolved to complete labels: the staff row of each part, in the
// order the text lists them. Every part of a `unique` candidate names one
// staff row and no row twice; anything else is kept as review text.
const staffOf = (
  candidate: StaffCandidate,
  staffByName: LabelIndex,
): null | readonly number[] => {
  if (candidate.resolution !== 'unique') {
    return null;
  }
  const ids = candidate.parts.map((part) => staffByName.get(part) ?? []);
  const flat = ids.flat();
  return ids.every((matches) => matches.length === 1) &&
    new Set(flat).size === flat.length
    ? flat
    : null;
};

const reviewFinding = (context: Context, candidate: StaffCandidate) => {
  const base = { collection, ids: [context.row.id], label: context.label };
  const where = `${candidate.role} text of assignment ${String(context.row.id)} for ${quote(context.label)}`;
  return candidate.resolution === 'ambiguous'
    ? finding('ambiguous_staff_label', {
        ...base,
        message: `${where} names staff rows ${listIds(candidate.staff)} through a label several of them carry; a review row keeps the text and links no staff.`,
      })
    : finding('unresolved_staff_text', {
        ...base,
        message: `${where} is not a complete staff label or an unambiguous list of them joined exactly by "${staffListSeparator}"; a review row keeps the text and links no staff.`,
      });
};

const roleRows = (
  out: Collector<RoleRowRecord>,
  input: AssignmentInput,
  context: Context,
): void => {
  const candidate = input.candidates.find(({ id }) => id === context.row.id);
  const items = candidate?.staff ?? [];
  for (const item of items) {
    if (item.resolution === 'none') {
      continue;
    }
    const staff = staffOf(item, input.staffByName);
    if (staff === null) {
      out.find(reviewFinding(context, item));
    }
    emitPair(out, input, {
      context,
      role: item.role,
      values:
        staff === null
          ? [{ display_override: item.text, staff: null }]
          : staff.map((id) => ({ display_override: null, staff: id })),
    });
  }
};

const courseFinding = (
  row: AssignmentRow,
  course: Candidates['assignments'][number]['course'],
) =>
  course.resolution === 'ambiguous'
    ? finding('ambiguous_course_name', {
        collection,
        ids: [row.id],
        label: course.label,
        message: `${quote(course.label)} names courses ${listIds(course.matches)}; assignment row ${String(row.id)} is retained and gets no role rows until the courses are told apart.`,
      })
    : finding('orphan_assignment', {
        collection,
        ids: [row.id],
        label: course.label,
        message: `assignment row ${String(row.id)} names no existing course (${quote(course.label)}); it is retained with its text for review.`,
      });

// Every assignment row in id order, duplicates included: rows whose course
// label names exactly one course get role rows; an orphan or ambiguous
// course label keeps the original row untouched and reports it. Names are
// never split on spaces, and professors_override is never read here. The
// checkpoint derivation published only the first row of a course, so the
// export readiness blocks a course whose published list merges role rows
// of two source rows (assignment_source_duplicate) until one is removed.
export const convertTeachingAssignments = (
  input: AssignmentInput,
): Conversion<RoleRowRecord> => {
  const out = new Collector<RoleRowRecord>();
  for (const candidate of input.candidates) {
    const row = input.rows.find(({ id }) => id === candidate.id);
    if (row === undefined) {
      throw new ConverterError(
        `Assignment candidate ${String(candidate.id)} has no checkpoint row.`,
      );
    }
    const { label, precedent: course, resolution } = candidate.course;
    if (resolution !== 'unique' || label === null || course === null) {
      out.find(courseFinding(row, candidate.course));
      out.settle(
        unresolved({ collection, id: row.id, relation: 'course' }, 'courses'),
      );
      continue;
    }
    roleRows(out, input, { course, label, row });
  }
  return out.result();
};

// The checkpoint derivation displays the first ascending id per course
// name, so a role row must sort after every original text row. A row id
// at or below the last original (a lagging id sequence) would silently
// blank the published professors and assistants: the step fails instead.
export const assertRoleRowsAppended = (
  ids: Iterable<number>,
  lastOriginal: number,
): void => {
  const early = [...ids].filter((id) => id <= lastOriginal);
  if (early.length > 0) {
    throw new ConverterWriteError(
      `Converter bug: role rows ${listIds(early)} of teaching_assignments received ids at or below the last original assignment row ${String(lastOriginal)}, so the checkpoint derivation (first ascending id per course name) would display them instead of the original text. Remove the appended rows and advance the id sequence past the originals before running again; never retry blindly.`,
    );
  }
};
