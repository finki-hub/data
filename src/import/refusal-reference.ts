import { sheetPlace } from '../workbook-values.js';
import { type Finding, type FindingCode, relatedIds } from './findings.js';
import { nonEmpty } from './labels.js';
import {
  channelNameAt,
  courseRow,
  headerOf,
  quoted,
  type RefusalContext,
  rowsAt,
  sheetOf,
} from './refusal-places.js';

// The refusal lines of the cases on the reference sheets, whose cells the
// general lines cannot place: a Discord course name by its row, its
// Предмет cell and its position there, and a
// Деканат staff name by its cell, never its value. Every other case keeps
// its general line (refusal-text.ts).

type Line = (finding: Finding, context: RefusalContext) => string;

// A Discord course name several courses carry, quoted as they carry it,
// and their rows.
const ambiguousChannelCourse: Line = (finding, context) => {
  const { channelName, collection, ids } = finding;
  const courses = relatedIds(finding, 'courses');
  const name = nonEmpty(courseRow(courses[0] ?? 0, context)?.name);
  const row = context.places[collection][(ids[0] ?? 0) - 1];
  const place =
    row === undefined || channelName === undefined
      ? rowsAt(collection, ids, context)
      : channelNameAt(row, channelName);
  return `${place} ${quoted(name)}: matches ${rowsAt('courses', courses, context)}`;
};

// The name cell of a Деканат row: Деканат row 7, column "Име".
const deanNameAt = ({ collection, ids }: Finding, context: RefusalContext) => {
  const row = context.places[collection][(ids[0] ?? 0) - 1];
  return row === undefined
    ? rowsAt(collection, ids, context)
    : sheetPlace(row.sheet, row.row, headerOf(collection, 'name'));
};

// The Деканат cases: a staff name by its cell (an empty one in the words
// the reader uses for an empty required cell), and rows repeating a year
// and position (a term has one holder).
const deanLines: Partial<Record<FindingCode, Line>> = {
  ambiguous_staff_name: (finding, context) =>
    `${deanNameAt(finding, context)}: matches ${rowsAt('staff', relatedIds(finding, 'staff'), context)}`,
  duplicate_role_row: ({ collection, ids }, context) =>
    `${rowsAt(collection, ids, context)}: same year and position`,
  invalid_source_row: (finding, context) =>
    `${deanNameAt(finding, context)}: missing required value`,
  unmatched_staff_name: (finding, context) =>
    `${deanNameAt(finding, context)}: not found in ${sheetOf('staff')}`,
};

// The line of a blocking case on a reference sheet, or null for a case
// the general lines place.
export const referenceLine = (
  finding: Finding,
  context: RefusalContext,
): null | string => {
  if (finding.collection === 'deans_office') {
    return deanLines[finding.code]?.(finding, context) ?? null;
  }
  return finding.code === 'ambiguous_course_name' &&
    finding.collection === 'discord_channels'
    ? ambiguousChannelCourse(finding, context)
    : null;
};
