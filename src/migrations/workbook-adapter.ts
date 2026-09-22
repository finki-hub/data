import type { z } from 'zod';

import type { DirectusRequest } from '../directus-request.js';
import type { LedgerOutcome } from './ledger-types.js';

import {
  type CollectionKey,
  collectionKeys,
  type MigrationData,
  type MigrationItem,
} from '../schema.js';
import {
  type ConversionPlan,
  countByCode,
  runConversion,
} from './conversion.js';
import { canonicalJson } from './fingerprint.js';
import { columnsSchema } from './inventory-fields.js';
import {
  assignmentRow,
  councilRow,
  courseRow,
  curriculum2018Row,
  curriculum2023Row,
  deansRow,
  discordRow,
  equivalencyRow,
  idRow,
  patternRow,
  staffRow,
  studentRow,
} from './inventory-schemas.js';
import { type CheckpointRows, readInventory } from './inventory.js';
import { preflight } from './preflight.js';

// The rows written for the workbook are not the rows the converters would
// read, or the relational model is not readable: the conversion never runs
// on data it cannot vouch for.
export class WorkbookAdapterError extends Error {
  public override readonly name = 'WorkbookAdapterError';
}

// The ids Directus gave the rows of a collection, in the order the workbook
// listed them.
export type IdsOf = (collection: CollectionKey) => readonly number[];

type Source = {
  readonly collection: CollectionKey;
  readonly ids: readonly number[];
  readonly items: readonly MigrationItem[];
};

const rowsOf = <S extends z.ZodType>(
  schema: S,
  { collection, ids, items }: Source,
): ReadonlyArray<z.output<S>> => {
  if (ids.length !== items.length) {
    throw new WorkbookAdapterError(
      `${collection} holds ${String(ids.length)} row(s), but the workbook supplied ${String(items.length)}.`,
    );
  }
  return items.map((item, index) => schema.parse({ ...item, id: ids[index] }));
};

// The checkpoint rows the converters read, built from the parsed workbook
// and the ids its rows received: each row carries exactly the columns the
// migration inventory reads, validated by the same schemas, so converting
// an imported workbook starts from the same input as upgrading a project
// that holds the same rows.
export const workbookCheckpoint = (
  data: MigrationData,
  idsOf: IdsOf,
): CheckpointRows => {
  const build = <S extends z.ZodType>(collection: CollectionKey, schema: S) =>
    rowsOf(schema, {
      collection,
      ids: idsOf(collection),
      items: data[collection],
    });
  return {
    course_enrollment_patterns: build('course_enrollment_patterns', patternRow),
    course_equivalencies: build('course_equivalencies', equivalencyRow),
    courses: build('courses', courseRow),
    curriculum_2018: build('curriculum_2018', curriculum2018Row),
    curriculum_2023: build('curriculum_2023', curriculum2023Row),
    deans_office: build('deans_office', deansRow),
    discord_channels: build('discord_channels', discordRow),
    moodle_users: build('moodle_users', idRow),
    rooms: build('rooms', idRow),
    staff: build('staff', staffRow),
    student_council: build('student_council', councilRow),
    students: build('students', studentRow),
    teaching_assignments: build('teaching_assignments', assignmentRow),
  };
};

// The ids of the rows a checkpoint read returned, ascending.
export const checkpointIds =
  (checkpoint: CheckpointRows): IdsOf =>
  (collection) => {
    const rows: ReadonlyArray<{ readonly id: number }> = checkpoint[collection];
    return rows.map(({ id }) => id);
  };

// Proves that the rows read back are the workbook rows, in workbook order,
// before the conversion consumes them.
export const assertImportedRows = (
  data: MigrationData,
  live: CheckpointRows,
): void => {
  const expected = workbookCheckpoint(data, checkpointIds(live));
  const differing = collectionKeys.filter(
    (collection) =>
      canonicalJson(expected[collection]) !== canonicalJson(live[collection]),
  );
  if (differing.length > 0) {
    throw new WorkbookAdapterError(
      `The rows read back from ${differing.join(', ')} differ from the workbook rows the import wrote; another writer changed the project during the import, or Directus stored a value differently. The relational conversion did not run.`,
    );
  }
};

// The blocker counts the relational conversion of this workbook would meet
// on an empty project, found offline for the dry run: the preflight over
// the rows as the import writes them (ids in workbook order), with no
// target row, Flow or extra column. Those only ever raise warnings, and
// the import refuses a project holding a record, so the counts equal what
// the import's own preflight finds after writing the rows.
export const previewBlockers = (
  data: MigrationData,
): Readonly<Record<string, number>> => {
  const checkpoint = workbookCheckpoint(data, (collection) =>
    data[collection].map((_, index) => index + 1),
  );
  const { blockers } = preflight(
    {
      checkpoint,
      fields: columnsSchema.parse(
        Object.fromEntries(collectionKeys.map((key) => [key, []])),
      ),
      flows: [],
      operations: [],
      targets: {
        academic_years: [],
        course_curricula: [],
        course_enrollment_rules: [],
        curriculum_entries: [],
      },
    },
    null,
  );
  return countByCode(blockers);
};

export type WorkbookConversion =
  | {
      readonly blockers: Readonly<Record<string, number>>;
      readonly status: 'blocked';
    }
  | {
      readonly status: 'converted';
      readonly steps: LedgerOutcome;
      readonly unresolved: Readonly<Record<string, number>>;
      readonly written: Readonly<Record<string, number>>;
    };

// Feeds the imported workbook rows into the relational conversion exactly
// as an upgrade would: the live inventory (checked against the workbook),
// its preflight, then the shared ledger steps. A blocker (an ambiguous
// relationship) stops before the ledger, like `--apply` refuses it; the
// rows stay imported and the upgrade path finishes the conversion once the
// blockers are resolved in Studio.
export const convertWorkbook = async (
  request: DirectusRequest,
  data: MigrationData,
  plan: ConversionPlan,
): Promise<WorkbookConversion> => {
  const inventory = await readInventory(request, {});
  if (inventory.targets === null) {
    throw new WorkbookAdapterError(
      'The relational collections are not readable after setup; the relational conversion did not run.',
    );
  }
  assertImportedRows(data, inventory.checkpoint);
  const live = preflight(inventory, null);
  if (live.blockers.length > 0) {
    return { blockers: countByCode(live.blockers), status: 'blocked' };
  }
  const { outcome, sink } = await runConversion(
    request,
    { inventory, live },
    plan,
  );
  return {
    status: 'converted',
    steps: outcome,
    unresolved: countByCode(sink.findings),
    written: sink.written,
  };
};
