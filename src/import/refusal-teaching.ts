import { teachingTexts } from '../../directus/extensions/directus-extension-data-operations/src/exports/teaching-values.js';
import { sheetPlace } from '../workbook-values.js';
import { type BlockerCode, type Finding, relatedIds } from './findings.js';
import { nonEmpty } from './labels.js';
import {
  courseRow,
  headerOf,
  linesText,
  quoted,
  type RefusalContext,
  rowsAt,
  sheetOf,
} from './refusal-places.js';

// The refusal lines of the teaching cases: the row the cells come from (a
// Наставен Кадар row, or an export row with typed professors), its column
// and the course, then the lines of the case. Never a cell text or a
// staff value.

type TeachingCode = Extract<
  BlockerCode,
  'ambiguous_staff_name' | 'inactive_course_assistants' | 'unmatched_staff_name'
>;

type Line = (finding: Finding, context: RefusalContext) => string;

// `<sheet> row N[, column "X"] «course»`.
const placeOf = (
  finding: Finding,
  context: RefusalContext,
  column?: string,
): string => {
  const { collection, ids } = finding;
  const place = context.places[collection][(ids[0] ?? 0) - 1];
  const course = courseRow(relatedIds(finding, 'courses')[0] ?? 0, context);
  const row =
    place === undefined
      ? rowsAt(collection, ids, context)
      : sheetPlace(place.sheet, place.row, column);
  return `${row} ${quoted(nonEmpty(course?.name))}`;
};

const columnOf = ({ collection, field }: Finding): string =>
  headerOf(collection, field ?? '');

export const teachingLines: Readonly<Record<TeachingCode, Line>> = {
  ambiguous_staff_name: (finding, context) => {
    const lines = finding.lines ?? [];
    const verb = lines.length === 1 ? 'matches' : 'match';
    return `${placeOf(finding, context, columnOf(finding))}: ${linesText(lines)} ${verb} ${rowsAt('staff', relatedIds(finding, 'staff'), context)}`;
  },
  inactive_course_assistants: (finding, context) =>
    `${placeOf(finding, context)}: column "${columnOf(finding)}" not empty for ${quoted(teachingTexts.inactive)}`,
  unmatched_staff_name: (finding, context) =>
    `${placeOf(finding, context, columnOf(finding))}: ${linesText(finding.lines ?? [])} not found in ${sheetOf('staff')}`,
};
