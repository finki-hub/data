import { type Finding, relatedIds } from './findings.js';
import { nonEmpty } from './labels.js';
import {
  channelNameAt,
  courseRow,
  quoted,
  type RefusalContext,
  rowsAt,
} from './refusal-places.js';

// The refusal lines of the cases on the reference sheets, whose cells the
// general lines cannot place: a Дискорд course name by its row, the
// column of its cell (the sheet heads none) and its position there. Every
// other case keeps its general line (refusal-text.ts).

// A Дискорд course name several courses carry, quoted as they carry it,
// and their rows.
const ambiguousChannelCourse = (
  finding: Finding,
  context: RefusalContext,
): string => {
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

// The line of a blocking case on a reference sheet, or null for a case
// the general lines place.
export const referenceLine = (
  finding: Finding,
  context: RefusalContext,
): null | string =>
  finding.code === 'ambiguous_course_name' &&
  finding.collection === 'discord_channels'
    ? ambiguousChannelCourse(finding, context)
    : null;
