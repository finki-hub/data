import {
  indexLabels,
  type LabelIndex,
  type LinkCandidate,
  nonEmpty,
  resolveLabel,
} from './labels.js';

// A curriculum sheet is laid out by semester: it lists a subject once in
// every semester block in which some study program takes it, each listing
// with the subject's code (the notes of its program columns name the
// semester of each program). A curriculum name therefore names every
// listing of its subject, and a code tells one subject from another.

type CurriculumRow = {
  readonly code: null | string;
  readonly id: number;
  readonly name: null | string;
};

// The rows of a curriculum sheet by exact name, and the code of each row.
export type CurriculumIndex = {
  readonly codes: ReadonlyMap<number, null | string>;
  readonly names: LabelIndex;
};

export const indexCurriculum = (
  rows: readonly CurriculumRow[],
): CurriculumIndex => ({
  codes: new Map(rows.map((row) => [row.id, nonEmpty(row.code)])),
  names: indexLabels(rows, (row) => nonEmpty(row.name)),
});

// The code every listing carries, or null when a listing has none or two
// listings differ.
const sharedCode = (
  ids: readonly number[],
  codes: CurriculumIndex['codes'],
): null | string => {
  const listed = new Set(ids.map((id) => codes.get(id) ?? null));
  const [code = null] = listed;
  return listed.size === 1 ? code : null;
};

// The rows a curriculum name names: several rows that all carry one code
// are the listings of one subject in several semester blocks, `repeated`
// and linked through the first of them (the earliest row of the sheet, as
// today's files link it); rows with different codes, or a row without a
// code, stay `ambiguous`.
export const resolveCurriculum = (
  label: null | string,
  { codes, names }: CurriculumIndex,
): LinkCandidate => {
  const link = resolveLabel(label, names);
  return link.resolution === 'ambiguous' &&
    sharedCode(link.matches, codes) !== null
    ? { ...link, resolution: 'repeated' }
    : link;
};
