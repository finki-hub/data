import type { CheckpointRows } from './inventory.js';

import {
  Collector,
  compositeKey,
  type Conversion,
  existing,
  pending,
} from './converter-types.js';

export type Generation = '2018' | '2023';
export type EntrySource = 'curriculum_2018' | 'curriculum_2023';

type CurriculumRow =
  | CheckpointRows['curriculum_2018'][number]
  | CheckpointRows['curriculum_2023'][number];

// One curriculum_entries row per checkpoint curriculum row: every column
// copied literally (an empty string stays an empty string; the checkpoint
// derivation's null mapping belongs to the projection, not to the copy), the
// states of the other generation left null, and the provenance recorded.
export type EntryRecord = {
  readonly catalog_order: null | number;
  readonly channel: boolean | null;
  readonly code: null | string;
  readonly generation: Generation;
  readonly level: null | number;
  readonly name: string;
  readonly prerequisites: null | string;
  readonly semester: null | number;
  readonly source_collection: EntrySource;
  readonly source_id: number;
  readonly state_ie: null | string;
  readonly state_imb: null | string;
  readonly state_ke: null | string;
  readonly state_ki: null | string;
  readonly state_kn: null | string;
  readonly state_pit: null | string;
  readonly state_seis: null | string;
  readonly state_siis: null | string;
  readonly state_ssp: null | string;
  readonly url: null | string;
};

// Keyed by the provenance columns of curriculum_entries, so a key built
// from a checkpoint row and one read back from a target row agree.
export const entryKey = (collection: string, id: number | string) =>
  compositeKey(collection, id);

const entryCollection = 'curriculum_entries';

const entryOf = (collection: EntrySource, row: CurriculumRow): EntryRecord => ({
  catalog_order: row.catalog_order,
  channel: row.channel,
  code: row.code,
  generation: collection === 'curriculum_2023' ? '2023' : '2018',
  level: row.level,
  name: row.name ?? '',
  prerequisites: row.prerequisites,
  semester: row.semester,
  source_collection: collection,
  source_id: row.id,
  state_ie: 'state_ie' in row ? row.state_ie : null,
  state_imb: row.state_imb,
  state_ke: 'state_ke' in row ? row.state_ke : null,
  state_ki: row.state_ki,
  state_kn: row.state_kn,
  state_pit: row.state_pit,
  state_seis: row.state_seis,
  state_siis: row.state_siis,
  state_ssp: 'state_ssp' in row ? row.state_ssp : null,
  url: row.url,
});

// Every 2023 row, then every 2018 row, in id order; a row whose provenance
// already names a target is reused, never copied twice.
export const convertCurriculumEntries = (
  checkpoint: CheckpointRows,
  existingEntries: ReadonlyMap<string, number>,
): Conversion<EntryRecord> => {
  const out = new Collector<EntryRecord>();
  const add = (collection: EntrySource, rows: readonly CurriculumRow[]) => {
    for (const row of rows) {
      const source = { collection, id: row.id, relation: 'entry' };
      const id = existingEntries.get(entryKey(collection, row.id));
      if (id === undefined) {
        out.write(entryOf(collection, row), [pending(source, entryCollection)]);
      } else {
        out.settle(existing(source, entryCollection, id));
      }
    }
  };
  add('curriculum_2023', checkpoint.curriculum_2023);
  add('curriculum_2018', checkpoint.curriculum_2018);
  return out.result();
};
