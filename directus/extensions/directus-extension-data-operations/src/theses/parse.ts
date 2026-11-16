import { z } from 'zod';

// What the import reads from the two theses APIs of theses-listing
// (bachelors-api and masters-api.finki-hub.com), and the rows it stores.
// Pure.

const text = z.string().nullish();
const fileId = z.union([z.string(), z.number()]).nullish();

export const bachelorsSchema = z.array(
  z.object({
    dateOfSubmission: text,
    description: text,
    fileId,
    member1: text,
    member2: text,
    mentor: text,
    status: text,
    student: text,
    title: z.string(),
  }),
);

export const mastersSchema = z.array(
  z.object({
    dateOfPresentation: text,
    description: text,
    fileId,
    member: text,
    mentor: text,
    president: text,
    status: text,
    student: text,
    title: z.string(),
  }),
);

export type BachelorRow = SharedRow & {
  readonly member_1: null | string;
  readonly member_2: null | string;
  // The day of the submission, YYYY-MM-DD.
  readonly submitted: null | string;
};

export type MasterRow = SharedRow & {
  readonly member: null | string;
  // The day of the defence, YYYY-MM-DD; empty until it is set.
  readonly presented: null | string;
  readonly president: null | string;
};

type SharedRow = {
  readonly description: null | string;
  readonly file_id: null | string;
  readonly mentor: null | string;
  readonly status: null | string;
  readonly student_index: null | string;
  readonly student_name: null | string;
  readonly title: string;
};

const spaces = /\s+/gu;

// The text with its whitespace collapsed; empty is null.
export const tidy = (value: null | string | undefined): null | string => {
  const result = (value ?? '').replaceAll(spaces, ' ').trim();
  return result === '' ? null : result;
};

const studentPattern = /^(?<index>\d+) - (?<name>\S.*)$/u;

// "216022 - Бојана  Јанческа": the index number and the name.
export const splitStudent = (
  value: null | string | undefined,
): { readonly index: null | string; readonly name: null | string } => {
  const student = tidy(value);
  const groups =
    student === null ? undefined : studentPattern.exec(student)?.groups;
  return groups === undefined
    ? { index: null, name: student }
    : { index: groups['index'] ?? null, name: tidy(groups['name']) };
};

const datePattern = /^(?<day>\d{1,2})\.(?<month>\d{1,2})\.(?<year>\d{4})$/u;

// "12.11.2026" as 2026-11-12; anything else is null.
export const isoDate = (value: null | string | undefined): null | string => {
  const groups = datePattern.exec(tidy(value) ?? '')?.groups;
  if (groups === undefined) {
    return null;
  }
  const { day = '', month = '', year = '' } = groups;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
};

const fileIdOf = (value: null | number | string | undefined): null | string =>
  value === null || value === undefined ? null : tidy(String(value));

export const bachelorRows = (
  theses: z.infer<typeof bachelorsSchema>,
): BachelorRow[] =>
  theses.map((thesis) => {
    const student = splitStudent(thesis.student);
    return {
      description: tidy(thesis.description),
      file_id: fileIdOf(thesis.fileId),
      member_1: tidy(thesis.member1),
      member_2: tidy(thesis.member2),
      mentor: tidy(thesis.mentor),
      status: tidy(thesis.status),
      student_index: student.index,
      student_name: student.name,
      submitted: isoDate(thesis.dateOfSubmission),
      title: tidy(thesis.title) ?? '',
    };
  });

export const masterRows = (
  theses: z.infer<typeof mastersSchema>,
): MasterRow[] =>
  theses.map((thesis) => {
    const student = splitStudent(thesis.student);
    return {
      description: tidy(thesis.description),
      file_id: fileIdOf(thesis.fileId),
      member: tidy(thesis.member),
      mentor: tidy(thesis.mentor),
      presented: isoDate(thesis.dateOfPresentation),
      president: tidy(thesis.president),
      status: tidy(thesis.status),
      student_index: student.index,
      student_name: student.name,
      title: tidy(thesis.title) ?? '',
    };
  });
