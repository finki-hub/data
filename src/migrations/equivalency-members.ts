import type { CheckpointRows } from './inventory.js';
import type { Candidates } from './report.js';

import {
  Collector,
  compositeKey,
  type Conversion,
  ConverterError,
  existing,
  pending,
  unresolved,
} from './converter-types.js';
import { entryKey, type GenerationIds } from './curricula.js';
import { type EntrySource, workbookGenerations } from './generations.js';
import { finding, type LinkCandidate, listIds, quote } from './labels.js';

// The members of each workbook equivalency row: one per generation whose
// label column is filled, with the label copied literally and the entry
// linked when the label names exactly one curriculum row of that
// generation, the decisions of the preflight. A label-only generation
// (2013) names no entry.

export type MemberRecord = {
  readonly entry: null | number;
  readonly equivalency: number;
  readonly generation: number;
  readonly label: string;
  readonly sort: number;
};

// A member already present for an equivalency and generation.
export type ExistingMember = {
  readonly entry: null | number;
  readonly id: number;
};

export const memberKey = (equivalency: number, generation: number) =>
  compositeKey(equivalency, generation);

type Candidate = Candidates['equivalencies'][number];
type Row = CheckpointRows['course_equivalencies'][number];

const collection = 'course_equivalencies';
const memberCollection = 'course_equivalency_members';

// The preflight's entry candidate of each curriculum sheet.
const entryCandidates: Readonly<
  Record<EntrySource, (candidate: Candidate) => LinkCandidate>
> = {
  curriculum_2018: (candidate) => candidate.entry2018,
  curriculum_2023: (candidate) => candidate.entry2023,
};

// The label columns in sheet order (2023, 2018, 2013), each with its
// generation; the order is the members' sort.
const columns = [...workbookGenerations].toReversed();

export type MemberInput = {
  readonly candidates: Candidates['equivalencies'];
  readonly entryIds: ReadonlyMap<string, number>;
  readonly existing: ReadonlyMap<string, ExistingMember>;
  readonly generationIds: GenerationIds;
  readonly rows: readonly Row[];
};

type Planned = {
  readonly code: string;
  readonly entry: null | number;
  readonly link: LinkCandidate | null;
  readonly row: Row;
  readonly sheet: EntrySource | null;
};

const idOf = (ids: GenerationIds, code: string): number => {
  const id = ids.get(code);
  if (id === undefined) {
    throw new ConverterError(
      `The generation ${code} was not created before its equivalency members.`,
    );
  }
  return id;
};

const entryOf = (
  input: MemberInput,
  { link, sheet }: Pick<Planned, 'link' | 'sheet'>,
): null | number => {
  if (link?.resolution !== 'unique' || sheet === null) {
    return null;
  }
  const entry =
    link.precedent === null
      ? undefined
      : input.entryIds.get(entryKey(sheet, link.precedent));
  if (entry === undefined) {
    throw new ConverterError(
      `The ${sheet} entry ${String(link.precedent)} named by an equivalency was not created before its member.`,
    );
  }
  return entry;
};

const linkFinding = ({ code, link, row }: Planned) => {
  const base = { collection, ids: [row.id], label: link?.label ?? null };
  return link?.resolution === 'ambiguous'
    ? finding('ambiguous_equivalency_entry', {
        ...base,
        message: `${quote(link.label)} matches curriculum_${code} rows ${listIds(link.matches)}; the ${code} member of equivalency row ${String(row.id)} keeps its label without an entry until resolved.`,
      })
    : finding('unmatched_equivalency_entry', {
        ...base,
        message: `${quote(link?.label ?? null)} matches no curriculum_${code} row; the ${code} member of equivalency row ${String(row.id)} keeps its label without an entry.`,
      });
};

// The entry decision of a member, recorded beside the member row.
const settleEntry = (out: Collector<MemberRecord>, planned: Planned): void => {
  const { code, entry, link, row } = planned;
  if (link === null || link.resolution === 'none') {
    return;
  }
  const source = { collection, id: row.id, relation: `entry_${code}` };
  if (entry === null) {
    out.find(linkFinding(planned));
    out.settle(unresolved(source, 'curriculum_entries'));
    return;
  }
  out.settle(existing(source, 'curriculum_entries', entry));
};

type Column = (typeof columns)[number];

// The member of one filled label column: reused when present, and one
// linked by hand to another entry is retained and reported.
const convertColumn = (
  out: Collector<MemberRecord>,
  input: MemberInput,
  { column, row, sort }: { column: Column; row: Row; sort: number },
): void => {
  const { code, equivalencyColumn, sheet } = column;
  const label = row[equivalencyColumn];
  if (label === null || label === '') {
    return;
  }
  const candidate = input.candidates.find(({ id }) => id === row.id);
  const link =
    candidate === undefined || sheet === null
      ? null
      : entryCandidates[sheet](candidate);
  const entry = entryOf(input, { link, sheet });
  const generation = idOf(input.generationIds, code);
  settleEntry(out, { code, entry, link, row, sheet });
  const source = { collection, id: row.id, relation: `member_${code}` };
  const present = input.existing.get(memberKey(row.id, generation));
  if (present === undefined) {
    out.write({ entry, equivalency: row.id, generation, label, sort }, [
      pending(source, memberCollection),
    ]);
    return;
  }
  if (entry !== null && present.entry !== entry) {
    out.find(
      finding('manual_link_retained', {
        collection: memberCollection,
        ids: [present.id],
        label,
        message: `course_equivalency_members row ${String(present.id)} already links the ${code} member of equivalency row ${String(row.id)} to entry ${String(present.entry)} while its label names entry ${String(entry)}; the link set by hand is retained.`,
      }),
    );
  }
  out.settle(existing(source, memberCollection, present.id));
};

// Up to three members per equivalency row, one per filled label column,
// in sheet order.
export const convertEquivalencyMembers = (
  input: MemberInput,
): Conversion<MemberRecord> => {
  const out = new Collector<MemberRecord>();
  for (const row of input.rows) {
    for (const [index, column] of columns.entries()) {
      convertColumn(out, input, { column, row, sort: index + 1 });
    }
  }
  return out.result();
};
