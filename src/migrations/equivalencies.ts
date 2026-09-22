import type { Candidates } from './report.js';
import type { SourceMapEntry } from './source-map.js';

import {
  Collector,
  type Conversion,
  ConverterError,
  existing,
  pending,
  unresolved,
} from './converter-types.js';
import { entryKey, type EntrySource } from './curricula.js';
import { finding, type LinkCandidate, listIds, quote } from './labels.js';

export type EquivalencyLinkColumn = 'course' | 'entry_2018' | 'entry_2023';

// A patch of the link columns of one equivalency row: only the columns to
// set are present. The three labels of the row are never touched.
export type EquivalencyLinkRecord = Partial<
  Readonly<Record<EquivalencyLinkColumn, number>>
> & { readonly id: number };

export type EquivalencyLinks = Readonly<
  Record<EquivalencyLinkColumn, null | number>
>;

type Row = Candidates['equivalencies'][number];

const collection = 'course_equivalencies';

const emptyLinks: EquivalencyLinks = {
  course: null,
  entry_2018: null,
  entry_2023: null,
};

export type EquivalencyInput = {
  readonly candidates: Candidates['equivalencies'];
  // The link columns as the rows carry them now: a link already set is
  // skipped and a link set by hand is never overwritten.
  readonly current: ReadonlyMap<number, EquivalencyLinks>;
  readonly entryIds: ReadonlyMap<string, number>;
};

type Relation = {
  readonly column: EquivalencyLinkColumn;
  readonly entrySource: EntrySource | null;
  readonly link: (row: Row) => LinkCandidate;
  readonly targetCollection: string;
};

const relations: readonly Relation[] = [
  {
    column: 'course',
    entrySource: null,
    link: (row) => row.course,
    targetCollection: 'courses',
  },
  {
    column: 'entry_2023',
    entrySource: 'curriculum_2023',
    link: (row) => row.entry2023,
    targetCollection: 'curriculum_entries',
  },
  {
    column: 'entry_2018',
    entrySource: 'curriculum_2018',
    link: (row) => row.entry2018,
    targetCollection: 'curriculum_entries',
  },
];

const targetOf = (
  input: EquivalencyInput,
  relation: Relation,
  link: LinkCandidate,
): number => {
  if (link.precedent === null) {
    throw new ConverterError('A unique link carries no precedent.');
  }
  if (relation.entrySource === null) {
    return link.precedent;
  }
  const entry = input.entryIds.get(
    entryKey(relation.entrySource, link.precedent),
  );
  if (entry === undefined) {
    throw new ConverterError(
      `The ${relation.entrySource} entry ${String(link.precedent)} named by an equivalency was not created before its link.`,
    );
  }
  return entry;
};

const courseFinding = (id: number, link: LinkCandidate) =>
  link.resolution === 'ambiguous'
    ? finding('ambiguous_course_name', {
        collection,
        ids: [id],
        label: link.label,
        message: `${quote(link.label)} names courses ${listIds(link.matches)}; equivalency row ${String(id)} keeps its labels and no course link until the courses are told apart.`,
      })
    : finding('orphan_equivalency', {
        collection,
        ids: [id],
        label: link.label,
        message: `equivalency row ${String(id)} names no existing course (${quote(link.label)}); it is retained with its labels for review.`,
      });

const entryFinding = (id: number, relation: Relation, link: LinkCandidate) => {
  const generation = relation.column.slice('entry_'.length);
  return link.resolution === 'ambiguous'
    ? finding('ambiguous_equivalency_entry', {
        collection,
        ids: [id],
        label: link.label,
        message: `${quote(link.label)} matches curriculum_${generation} rows ${listIds(link.matches)}; the ${generation} entry link of equivalency row ${String(id)} stays empty until resolved.`,
      })
    : finding('unmatched_equivalency_entry', {
        collection,
        ids: [id],
        label: link.label,
        message: `${quote(link.label)} matches no curriculum_${generation} row; the label is retained on equivalency row ${String(id)} without a ${generation} entry link.`,
      });
};

const manualFinding = (
  row: Row,
  relation: Relation,
  { current, target }: { current: number; target: number },
) =>
  finding('manual_link_retained', {
    collection,
    ids: [row.id],
    label: relation.link(row).label,
    message: `equivalency row ${String(row.id)} already links ${relation.column} ${String(current)} while its label names ${String(target)}; the link set by hand is retained.`,
  });

type Planned = {
  readonly mappings: SourceMapEntry[];
  readonly patch: Record<EquivalencyLinkColumn, number | undefined>;
  readonly row: Row;
};

const planRelation = (
  out: Collector<EquivalencyLinkRecord>,
  input: EquivalencyInput,
  { planned, relation }: { planned: Planned; relation: Relation },
): void => {
  const { row } = planned;
  const link = relation.link(row);
  const source = { collection, id: row.id, relation: relation.column };
  const current = (input.current.get(row.id) ?? emptyLinks)[relation.column];
  const target =
    link.resolution === 'unique' ? targetOf(input, relation, link) : null;
  if (current !== null) {
    if (target !== null && target !== current) {
      out.find(manualFinding(row, relation, { current, target }));
    }
    out.settle(existing(source, relation.targetCollection, current));
    return;
  }
  if (target !== null) {
    planned.patch[relation.column] = target;
    planned.mappings.push(pending(source, relation.targetCollection, target));
    return;
  }
  if (link.resolution === 'none' && relation.column !== 'course') {
    return;
  }
  out.find(
    relation.column === 'course'
      ? courseFinding(row.id, link)
      : entryFinding(row.id, relation, link),
  );
  out.settle(unresolved(source, relation.targetCollection));
};

const patchOf = ({ patch, row }: Planned): EquivalencyLinkRecord => ({
  id: row.id,
  ...(patch.course !== undefined && { course: patch.course }),
  ...(patch.entry_2023 !== undefined && { entry_2023: patch.entry_2023 }),
  ...(patch.entry_2018 !== undefined && { entry_2018: patch.entry_2018 }),
});

// Sets the course link when the 2023 label names exactly one course and
// the entry link of each represented generation when its label names
// exactly one curriculum row. Every label, the 2013 one included, stays as
// it is; a row nothing resolves for is retained and reported.
export const convertEquivalencyLinks = (
  input: EquivalencyInput,
): Conversion<EquivalencyLinkRecord> => {
  const out = new Collector<EquivalencyLinkRecord>();
  for (const row of input.candidates) {
    const planned: Planned = {
      mappings: [],
      patch: {
        course: undefined,
        entry_2018: undefined,
        entry_2023: undefined,
      },
      row,
    };
    for (const relation of relations) {
      planRelation(out, input, { planned, relation });
    }
    if (planned.mappings.length > 0) {
      out.write(patchOf(planned), planned.mappings);
    }
  }
  return out.result();
};
