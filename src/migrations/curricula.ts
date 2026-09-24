import type { CheckpointRows } from './inventory.js';

import {
  Collector,
  compositeKey,
  type Conversion,
  ConverterError,
  existing,
  pending,
} from './converter-types.js';
import {
  type EntrySource,
  generationOfSheet,
  programKey,
  stateColumns,
} from './generations.js';

type CurriculumRow =
  | CheckpointRows['curriculum_2018'][number]
  | CheckpointRows['curriculum_2023'][number];

// One curriculum_entries row per checkpoint curriculum row: every column
// copied literally (an empty string stays an empty string; the checkpoint
// derivation's null mapping belongs to the projection, not to the copy),
// the generation of its sheet, and the provenance recorded. Its program
// states become rows of their own.
export type EntryRecord = {
  readonly catalog_order: null | number;
  readonly channel: boolean | null;
  readonly code: null | string;
  readonly generation: number;
  readonly level: null | number;
  readonly name: string;
  readonly prerequisites: null | string;
  readonly semester: null | number;
  readonly source_collection: EntrySource;
  readonly source_id: number;
  readonly url: null | string;
};

// Keyed by the provenance columns of curriculum_entries, so a key built
// from a checkpoint row and one read back from a target row agree.
export const entryKey = (collection: string, id: number | string) =>
  compositeKey(collection, id);

const entryCollection = 'curriculum_entries';
const stateCollection = 'curriculum_entry_program_states';

// The ids of the generation rows, by code.
export type GenerationIds = ReadonlyMap<string, number>;

const generationId = (
  generations: GenerationIds,
  collection: EntrySource,
): number => {
  const code = generationOfSheet(collection);
  const id = generations.get(code);
  if (id === undefined) {
    throw new ConverterError(
      `The generation ${code} of ${collection} was not created before its entries.`,
    );
  }
  return id;
};

const entryOf = (
  collection: EntrySource,
  row: CurriculumRow,
  generation: number,
): EntryRecord => ({
  catalog_order: row.catalog_order,
  channel: row.channel,
  code: row.code,
  generation,
  level: row.level,
  name: row.name ?? '',
  prerequisites: row.prerequisites,
  semester: row.semester,
  source_collection: collection,
  source_id: row.id,
  url: row.url,
});

const sheetsOf = (
  checkpoint: CheckpointRows,
): ReadonlyArray<readonly [EntrySource, readonly CurriculumRow[]]> => [
  ['curriculum_2023', checkpoint.curriculum_2023],
  ['curriculum_2018', checkpoint.curriculum_2018],
];

// Every 2023 row, then every 2018 row, in id order; a row whose provenance
// already names a target is reused, never copied twice.
export const convertCurriculumEntries = (
  checkpoint: CheckpointRows,
  ids: {
    readonly entries: ReadonlyMap<string, number>;
    readonly generations: GenerationIds;
  },
): Conversion<EntryRecord> => {
  const out = new Collector<EntryRecord>();
  for (const [collection, rows] of sheetsOf(checkpoint)) {
    const generation = generationId(ids.generations, collection);
    for (const row of rows) {
      const source = { collection, id: row.id, relation: 'entry' };
      const id = ids.entries.get(entryKey(collection, row.id));
      if (id === undefined) {
        out.write(entryOf(collection, row, generation), [
          pending(source, entryCollection),
        ]);
      } else {
        out.settle(existing(source, entryCollection, id));
      }
    }
  }
  return out.result();
};

export type StateRecord = {
  readonly entry: number;
  readonly program: number;
  readonly state: string;
};

export const stateKey = (entry: number | string, program: number | string) =>
  compositeKey(entry, program);

const cellOf = (row: CurriculumRow, column: string): unknown =>
  Object.entries(row).find(([key]) => key === column)?.[1];

type StateIds = {
  readonly entries: ReadonlyMap<string, number>;
  readonly generations: GenerationIds;
  readonly programs: ReadonlyMap<string, number>;
  readonly states: ReadonlyMap<string, number>;
};

type StateCell = {
  readonly collection: EntrySource;
  readonly entry: number;
  readonly generation: number;
  readonly row: CurriculumRow;
  readonly target: string;
};

// The state row of one program cell, or nothing for an empty cell.
const convertCell = (
  out: Collector<StateRecord>,
  ids: StateIds,
  cell: StateCell,
): void => {
  const { collection, entry, generation, row, target } = cell;
  const state = cellOf(row, target);
  if (typeof state !== 'string' || state === '') {
    return;
  }
  const code = target.slice('state_'.length);
  const program = ids.programs.get(programKey(generation, code));
  if (program === undefined) {
    throw new ConverterError(
      `The program ${code} of ${collection} was not created before its states.`,
    );
  }
  const source = { collection, id: row.id, relation: target };
  const id = ids.states.get(stateKey(entry, program));
  if (id === undefined) {
    out.write({ entry, program, state }, [pending(source, stateCollection)]);
  } else {
    out.settle(existing(source, stateCollection, id));
  }
};

// One state row per nonempty program cell of every curriculum row, for the
// program of the entry's generation that column names; an empty cell
// writes none, which the projection publishes like the empty column it
// was (the key is omitted). A state already present is reused.
export const convertProgramStates = (
  checkpoint: CheckpointRows,
  ids: StateIds,
): Conversion<StateRecord> => {
  const out = new Collector<StateRecord>();
  for (const [collection, rows] of sheetsOf(checkpoint)) {
    const generation = generationId(ids.generations, collection);
    const columns = stateColumns(collection);
    for (const row of rows) {
      const entry = ids.entries.get(entryKey(collection, row.id));
      if (entry === undefined) {
        throw new ConverterError(
          `The ${collection} entry ${String(row.id)} was not created before its program states.`,
        );
      }
      for (const { target } of columns) {
        convertCell(out, ids, { collection, entry, generation, row, target });
      }
    }
  }
  return out.result();
};
