// The teaching values of courses.json, declared once: a course's status,
// the roles of its staff links, the texts a status publishes in place of
// names, and the separator between names. The workbook import
// (src/import/teaching-cells.ts) reads them from here. Pure: it imports
// nothing.

// Active publishes names from the course's staff links. All professors
// publishes its text as professors; assistants still come from the links.
// Inactive publishes its text as professors and as assistants.
export const courseStatuses = ['active', 'all_professors', 'inactive'] as const;

export type CourseStatus = (typeof courseStatuses)[number];

export const assignmentRoles = ['professor', 'assistant'] as const;

export type AssignmentRole = (typeof assignmentRoles)[number];

// The published texts of the two statuses that replace names. A workbook
// professors cell holding exactly one of them gives that status.
export const teachingTexts = {
  allProfessors: 'Сите професори',
  inactive: '(неактивиран предмет)',
} as const;

// The names of one role are published one per line.
export const labelSeparator = '\n';

// The names in the order given (drag order), or null without a name.
const namesText = (names: readonly string[]): null | string =>
  names.length === 0 ? null : names.join(labelSeparator);

// professors: the text of All professors or Inactive whatever the links
// are, else the professor names; null for an Active course without one.
export const professorsText = (
  status: CourseStatus,
  names: readonly string[],
): null | string => {
  if (status === 'inactive') {
    return teachingTexts.inactive;
  }
  return status === 'all_professors'
    ? teachingTexts.allProfessors
    : namesText(names);
};

// assistants: the text of Inactive whatever the links are, else the
// assistant names; null without one, so the key is left out.
export const assistantsText = (
  status: CourseStatus,
  names: readonly string[],
): null | string =>
  status === 'inactive' ? teachingTexts.inactive : namesText(names);
