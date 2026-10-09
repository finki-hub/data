import { listText } from '../text.js';
import { sheetPlace } from '../workbook-values.js';
import {
  type BlockerCode,
  type Finding,
  isBlockerCode,
  relatedIds,
} from './findings.js';
import { type EntrySource, generationOfSheet } from './generations.js';
import { nonEmpty } from './labels.js';
import {
  courseRow,
  courseRowNamed,
  headerOf,
  quoted,
  type RefusalContext,
  rowsAt,
  sheetOf,
} from './refusal-places.js';
import { referenceLine } from './refusal-reference.js';
import { teachingLines } from './refusal-teaching.js';

// Every case that blocks the import, one line per code in one form:
// `<sheet> row N[, column "X"][ «course»]: <fact>[; <fact>]`, naming the
// rows, the cell and the course it concerns; a case on a reference sheet
// is placed by its cell (refusal-reference.ts). What to change is in
// README, per code.

type Line = (finding: Finding, context: RefusalContext) => string;

const firstId = ({ ids }: Finding): number => ids[0] ?? 0;

// A place and its facts: `<place>: <fact>[; <fact>]`.
const placed = (place: string, facts: readonly string[]): string =>
  `${place}: ${facts.join('; ')}`;

// The codes of the listings a name matches, each quoted exactly as its
// cell holds it (codes that differ only by a space are then told apart),
// `none` for a listing without one.
const codesFact = (
  sheet: EntrySource,
  ids: readonly number[],
  context: RefusalContext,
): string => {
  const listings = ids.map((id) => {
    const code = nonEmpty(context.rows[sheet][id - 1]?.code);
    const row = context.places[sheet][id - 1]?.row ?? id;
    return `row ${String(row)} ${code === null ? 'none' : quoted(code)}`;
  });
  return `codes: ${listText(listings)}`;
};

// The 2018 name of a course, and ` (from <rows>)` when it is taken from an
// equivalency row because the course has no 2018-name of its own.
const legacyName = (
  finding: Finding,
  context: RefusalContext,
): { readonly from: string; readonly label: null | string } => {
  const override = nonEmpty(
    courseRow(firstId(finding), context)?.name_2018_override,
  );
  const [source] = relatedIds(finding, 'course_equivalencies');
  if (override !== null || source === undefined) {
    return { from: '', label: override };
  }
  return {
    from: ` (from ${rowsAt('course_equivalencies', [source], context)})`,
    label: nonEmpty(context.rows.course_equivalencies[source - 1]?.course_2018),
  };
};

const ambiguousCurriculum =
  (sheet: EntrySource): Line =>
  (finding, context) => {
    const id = firstId(finding);
    const { from, label } =
      sheet === 'curriculum_2023'
        ? { from: '', label: nonEmpty(courseRow(id, context)?.name_2023) }
        : legacyName(finding, context);
    const matches = relatedIds(finding, sheet);
    return placed(courseRowNamed(id, context), [
      `${generationOfSheet(sheet)} name ${quoted(label)}${from} matches ${rowsAt(sheet, matches, context)}`,
      codesFact(sheet, matches, context),
    ]);
  };

// The cells a pattern row lacks.
const missingPatternCells = (
  id: number,
  context: RefusalContext,
): readonly string[] => {
  const row = context.rows.course_enrollment_patterns[id - 1];
  return [
    { label: 'course name', value: row?.course_name },
    { label: 'academic year', value: row?.academic_year },
    { label: 'pattern', value: row?.pattern },
  ].flatMap(({ label, value }) => (nonEmpty(value) === null ? [label] : []));
};

// What a row the model cannot hold lacks.
const missingCells = (finding: Finding, context: RefusalContext): string => {
  if (finding.collection === 'course_enrollment_patterns') {
    return listText(missingPatternCells(firstId(finding), context));
  }
  if (finding.collection === 'courses') {
    return 'name';
  }
  return finding.collection === 'student_council' ? 'index' : 'required value';
};

// The typed patterns of a course that are no regular expression.
const invalidRegex: Line = (finding, context) =>
  placed(courseRowNamed(firstId(finding), context), [
    `pattern not a valid regular expression: ${rowsAt('course_enrollment_patterns', relatedIds(finding, 'course_enrollment_patterns'), context)}`,
  ]);

// Credits of a generation without its name, and an availability of TRUE
// beside them.
const unlinkedValues: Line = (finding, context) => {
  const id = firstId(finding);
  const row = courseRow(id, context);
  const { generation } = finding;
  const place = courseRowNamed(id, context);
  if (row === undefined || generation === undefined) {
    return placed(place, ['generation name empty', 'credits set']);
  }
  const credits = row[`credits_${generation}`];
  const available = row[`available_${generation}`] === true;
  const values = [
    ...(credits === null ? [] : [`${generation} credits ${String(credits)}`]),
    ...(available ? [`${generation} available TRUE`] : []),
  ];
  return placed(place, [`${generation} name empty`, values.join(', ')]);
};

// A curriculum code that gives no level, by its cell, quoted.
const codeWithoutLevel: Line = ({ collection, ids }, context) => {
  const id = ids[0] ?? 0;
  const place = context.places[collection][id - 1];
  const code =
    collection === 'curriculum_2018' || collection === 'curriculum_2023'
      ? context.rows[collection][id - 1]?.code
      : null;
  return placed(
    place === undefined
      ? rowsAt(collection, ids, context)
      : sheetPlace(place.sheet, place.row, headerOf(collection, 'code')),
    [`${quoted(code ?? null)} has no level digit (expected F<yy>L<level>)`],
  );
};

const lines: Readonly<Record<BlockerCode, Line>> = {
  ambiguous_course_name: (finding, context) => {
    const courses = relatedIds(finding, 'courses');
    const name = nonEmpty(courseRow(courses[0] ?? 0, context)?.name);
    return placed(rowsAt(finding.collection, finding.ids, context), [
      `${quoted(name)} matches ${rowsAt('courses', courses, context)}`,
    ]);
  },
  ambiguous_curriculum_2018: ambiguousCurriculum('curriculum_2018'),
  ambiguous_curriculum_2023: ambiguousCurriculum('curriculum_2023'),
  ambiguous_legacy_equivalency: (finding, context) => {
    const rows = relatedIds(finding, 'course_equivalencies');
    const labels = new Set(
      rows.map((id) =>
        nonEmpty(context.rows.course_equivalencies[id - 1]?.course_2018),
      ),
    );
    return placed(courseRowNamed(firstId(finding), context), [
      `${rowsAt('course_equivalencies', rows, context)} give different 2018 names: ${listText([...labels].map(quoted))}`,
    ]);
  },
  ambiguous_staff_name: teachingLines.ambiguous_staff_name,
  ambiguous_student_index: (finding, context) =>
    placed(rowsAt(finding.collection, finding.ids, context), [
      `index matches several students: ${rowsAt('students', relatedIds(finding, 'students'), context)}`,
    ]),
  curriculum_code_without_level: codeWithoutLevel,
  duplicate_role_row: (finding, context) =>
    placed(rowsAt(finding.collection, finding.ids, context), [
      'same year, person and position',
    ]),
  inactive_course_assistants: teachingLines.inactive_course_assistants,
  invalid_regex: invalidRegex,
  invalid_source_row: (finding, context) =>
    placed(rowsAt(finding.collection, finding.ids, context), [
      `missing ${missingCells(finding, context)}`,
    ]),
  missing_override_target: (finding, context) => {
    const id = firstId(finding);
    return placed(courseRowNamed(id, context), [
      `2018-name ${quoted(nonEmpty(courseRow(id, context)?.name_2018_override))} matches no row of ${sheetOf('curriculum_2018')}`,
    ]);
  },
  unlinked_generation_values: unlinkedValues,
  unmatched_curriculum_2018_label: (finding, context) => {
    const { from, label } = legacyName(finding, context);
    return placed(courseRowNamed(firstId(finding), context), [
      `2018 name ${quoted(label)}${from} matches no row of ${sheetOf('curriculum_2018')}`,
    ]);
  },
  unmatched_curriculum_2023_label: (finding, context) => {
    const id = firstId(finding);
    return placed(courseRowNamed(id, context), [
      `2023 name ${quoted(nonEmpty(courseRow(id, context)?.name_2023))} matches no row of ${sheetOf('curriculum_2023')}`,
    ]);
  },
  unmatched_staff_name: teachingLines.unmatched_staff_name,
};

// A blocking case by its sheets and rows and the course it concerns.
export const refusalText = (
  finding: Finding,
  context: RefusalContext,
): string =>
  isBlockerCode(finding.code)
    ? (referenceLine(finding, context) ?? lines[finding.code](finding, context))
    : rowsAt(finding.collection, finding.ids, context);
