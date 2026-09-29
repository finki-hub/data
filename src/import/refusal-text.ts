import {
  type BlockerCode,
  type Finding,
  isBlockerCode,
  relatedIds,
} from './findings.js';
import { type EntrySource, generationOfSheet } from './generations.js';
import { nonEmpty } from './labels.js';
import {
  courseNamed,
  courseRow,
  courseRowNamed,
  joined,
  quoted,
  type RefusalContext,
  rowsAt,
  rowsOf,
  sheetOf,
} from './refusal-places.js';

// Every case that refuses the import, explained in plain words for the
// operator who corrects the workbook: what the rows say, which rows, and
// what to change. One sentence per blocking code.

type Sentence = (finding: Finding, context: RefusalContext) => string;

const firstId = ({ ids }: Finding): number => ids[0] ?? 0;

// The name a course is looked up by, when it differs from its name.
const nameNote = (label: null | string, name: null | string): string =>
  label === null || label === name ? '' : ` ${quoted(label)}`;

// Why several listings a name matches are not one subject, and what to do.
// Codes are compared exactly as the cells hold them, so each is quoted:
// codes that differ only by a space are then told apart.
const codesClause = (
  sheet: EntrySource,
  ids: readonly number[],
  context: RefusalContext,
): string => {
  const listings = ids.map((id) => ({
    code: nonEmpty(context.rows[sheet][id - 1]?.code),
    row: context.places[sheet][id - 1]?.row ?? id,
  }));
  const detail = listings
    .map(
      ({ code, row }) =>
        `row ${String(row)}: ${code === null ? 'no code' : quoted(code)}`,
    )
    .join(', ');
  return listings.some(({ code }) => code === null)
    ? `which do not all carry a code (${detail}); fill in the missing code if they list one subject, or give each subject its own name`
    : `which carry different codes (${detail}); give each subject its own name`;
};

// The 2018 name of a course, and the equivalency row it was taken from
// when the course has no 2018-name of its own.
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
    from: `, taken from ${rowsAt('course_equivalencies', [source], context)},`,
    label: nonEmpty(context.rows.course_equivalencies[source - 1]?.course_2018),
  };
};

const ambiguousCurriculum =
  (sheet: EntrySource): Sentence =>
  (finding, context) => {
    const id = firstId(finding);
    const row = courseRow(id, context);
    const name = nonEmpty(row?.name);
    const { from, label } =
      sheet === 'curriculum_2023'
        ? { from: '', label: nonEmpty(row?.name_2023) }
        : legacyName(finding, context);
    const matches = relatedIds(finding, sheet);
    return `${courseNamed(id, context)}: its ${generationOfSheet(sheet)} name${nameNote(label, name)}${from} matches ${rowsOf(sheet, matches, context)}, ${codesClause(sheet, matches, context)}.`;
  };

// The cells a pattern row lacks.
const missingPatternCells = (id: number, context: RefusalContext): string => {
  const row = context.rows.course_enrollment_patterns[id - 1];
  return joined(
    [
      { label: 'course name', value: row?.course_name },
      { label: 'academic year', value: row?.academic_year },
      { label: 'pattern', value: row?.pattern },
    ].flatMap(({ label, value }) => (nonEmpty(value) === null ? [label] : [])),
  );
};

// What a row the model cannot hold lacks.
const missingCells = (finding: Finding, context: RefusalContext): string => {
  if (finding.collection === 'course_enrollment_patterns') {
    return missingPatternCells(firstId(finding), context);
  }
  if (finding.collection === 'courses') {
    return 'name';
  }
  return finding.collection === 'student_council'
    ? 'index'
    : 'value in a cell the import requires';
};

const invalidRegex: Sentence = (finding, context) => {
  const id = firstId(finding);
  const fallback = `${nonEmpty(courseRow(id, context)?.name) ?? ''}-<year>`;
  const patterns = relatedIds(finding, 'course_enrollment_patterns');
  const one = patterns.length === 1;
  const clauses = [
    ...(patterns.length === 0
      ? []
      : [
          `the enrollment ${one ? 'pattern' : 'patterns'} on ${rowsAt('course_enrollment_patterns', patterns, context)} ${one ? 'is not a valid regular expression' : 'are not valid regular expressions'}; correct ${one ? 'it' : 'them'}`,
        ]),
    ...(relatedIds(finding, 'courses').length === 0
      ? []
      : [
          `the default enrollment pattern ${quoted(fallback)}, which applies to every year without a pattern in ${sheetOf('course_enrollment_patterns')}, is not a valid regular expression; add a valid pattern for each such year there, or rename the course`,
        ]),
  ];
  return `${courseNamed(id, context)}: ${clauses.join('. Also, ')}.`;
};

const unlinkedValues: Sentence = (finding, context) => {
  const id = firstId(finding);
  const row = courseRow(id, context);
  const { generation } = finding;
  const subject = courseRowNamed(id, context);
  if (row === undefined || generation === undefined) {
    return `${subject}: it holds credits or an availability of TRUE for a curriculum generation it has no name for; fill in that name, or clear the values.`;
  }
  const credits = row[`credits_${generation}`];
  const available = row[`available_${generation}`] === true;
  const facts = [
    ...(credits === null
      ? []
      : [`${generation} credits are ${String(credits)}`]),
    ...(available ? [`${generation} available is TRUE`] : []),
  ];
  const undo = [
    ...(credits === null ? [] : ['clear the credits']),
    ...(available ? ['set available to FALSE'] : []),
  ];
  return `${subject}: ${joined(facts)} but the ${generation} name is empty; fill in the ${generation} name or ${joined(undo)}.`;
};

const sentences: Readonly<Record<BlockerCode, Sentence>> = {
  ambiguous_course_name: (finding, context) => {
    const courses = relatedIds(finding, 'courses');
    const name = nonEmpty(courseRow(courses[0] ?? 0, context)?.name);
    return `${rowsAt(finding.collection, finding.ids, context)} names ${quoted(name)}, which ${rowsOf('courses', courses, context)} carry; give each course its own name.`;
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
    return `${courseNamed(firstId(finding), context)}: ${rowsAt('course_equivalencies', rows, context)} give it different 2018 names (${joined([...labels].map(quoted))}); make them agree, or fill in its 2018-name to choose one.`;
  },
  ambiguous_student_index: (finding, context) =>
    `${rowsAt(finding.collection, finding.ids, context)}: several students carry its index (${rowsAt('students', relatedIds(finding, 'students'), context)}); correct the index, or keep one student row for it.`,
  duplicate_assignment: (finding, context) => {
    const [course = 0] = relatedIds(finding, 'courses');
    return `${courseNamed(course, context)}: ${rowsAt(finding.collection, finding.ids, context)} ${finding.ids.length === 2 ? 'both' : 'all'} name it; keep one teaching row per course.`;
  },
  duplicate_role_row: (finding, context) =>
    `${rowsAt(finding.collection, finding.ids, context)} repeat the same year, person and position; delete the repeated ${finding.ids.length === 2 ? 'row' : 'rows'}.`,
  invalid_regex: invalidRegex,
  invalid_source_row: (finding, context) =>
    `${rowsAt(finding.collection, finding.ids, context)} has no ${missingCells(finding, context)}; fill it in or delete the row.`,
  missing_override_target: (finding, context) => {
    const id = firstId(finding);
    return `${courseNamed(id, context)}: its 2018-name ${quoted(nonEmpty(courseRow(id, context)?.name_2018_override))} matches no row of ${sheetOf('curriculum_2018')}; correct it to the name of a 2018 subject, or clear it.`;
  },
  unlinked_generation_values: unlinkedValues,
  unmatched_curriculum_2018_label: (finding, context) => {
    const { from, label } = legacyName(finding, context);
    return `${courseNamed(firstId(finding), context)}: its 2018 name ${quoted(label)}${from} matches no row of ${sheetOf('curriculum_2018')}; correct it in ${sheetOf('course_equivalencies')}, or fill in the course's 2018-name.`;
  },
  unmatched_curriculum_2023_label: (finding, context) => {
    const id = firstId(finding);
    return `${courseNamed(id, context)}: its 2023 name ${quoted(nonEmpty(courseRow(id, context)?.name_2023))} matches no row of ${sheetOf('curriculum_2023')}; correct it to the name of a 2023 subject.`;
  },
};

// A refusing case in plain words, by its sheets and rows and the course
// it concerns.
export const refusalText = (
  finding: Finding,
  context: RefusalContext,
): string =>
  isBlockerCode(finding.code)
    ? sentences[finding.code](finding, context)
    : rowsAt(finding.collection, finding.ids, context);
