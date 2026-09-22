import type { z } from 'zod';

import type { DirectusRequest } from '../directus-request.js';

import {
  type Columns,
  readCheckpointColumns,
  readColumnsOrNull,
} from './inventory-fields.js';
import {
  academicYearRow,
  type AssignmentRow,
  assignmentRow,
  type CouncilRow,
  councilRow,
  courseCurriculumRow,
  type CourseRow,
  courseRow,
  curriculum2018Row,
  curriculum2023Row,
  deansRow,
  discordRow,
  entryRow,
  type EquivalencyRow,
  equivalencyRow,
  type FlowRow,
  flowRow,
  idRow,
  type OperationRow,
  operationRow,
  type PatternRow,
  patternRow,
  ruleRow,
  staffRow,
  studentRow,
} from './inventory-schemas.js';
import { defaultPageSize, readAll } from './paging.js';

export type CheckpointRows = {
  readonly course_enrollment_patterns: readonly PatternRow[];
  readonly course_equivalencies: readonly EquivalencyRow[];
  readonly courses: readonly CourseRow[];
  readonly curriculum_2018: ReadonlyArray<z.infer<typeof curriculum2018Row>>;
  readonly curriculum_2023: ReadonlyArray<z.infer<typeof curriculum2023Row>>;
  readonly deans_office: ReadonlyArray<z.infer<typeof deansRow>>;
  readonly discord_channels: ReadonlyArray<z.infer<typeof discordRow>>;
  readonly moodle_users: ReadonlyArray<z.infer<typeof idRow>>;
  readonly rooms: ReadonlyArray<z.infer<typeof idRow>>;
  readonly staff: ReadonlyArray<z.infer<typeof staffRow>>;
  readonly student_council: readonly CouncilRow[];
  readonly students: ReadonlyArray<z.infer<typeof studentRow>>;
  readonly teaching_assignments: readonly AssignmentRow[];
};

export type TargetRows = {
  readonly academic_years: ReadonlyArray<z.infer<typeof academicYearRow>>;
  readonly course_curricula: ReadonlyArray<z.infer<typeof courseCurriculumRow>>;
  readonly course_enrollment_rules: ReadonlyArray<z.infer<typeof ruleRow>>;
  readonly curriculum_entries: ReadonlyArray<z.infer<typeof entryRow>>;
};

export type Inventory = {
  readonly checkpoint: CheckpointRows;
  readonly fields: Columns;
  readonly flows: readonly FlowRow[];
  readonly operations: readonly OperationRow[];
  readonly targets: null | TargetRows;
};

export type InventoryOptions = { readonly pageSize?: number };

const targetCollections = [
  'academic_years',
  'course_curricula',
  'course_enrollment_rules',
  'curriculum_entries',
] as const;

// An object schema whose rows carry an id, which the paged reader needs.
type RowSchema = z.ZodObject & z.ZodType<{ readonly id: number | string }>;

type Read<S extends RowSchema> = {
  readonly collection: string;
  readonly pageSize: number;
  readonly schema: S;
};

const rows = <S extends RowSchema>(
  request: DirectusRequest,
  { collection, pageSize, schema }: Read<S>,
): Promise<ReadonlyArray<z.output<S>>> =>
  readAll(request, {
    fields: Object.keys(schema.shape),
    pageSize,
    pathname: `/items/${collection}`,
    schema,
  });

const readCheckpoint = async (
  request: DirectusRequest,
  pageSize: number,
): Promise<CheckpointRows> => ({
  course_enrollment_patterns: await rows(request, {
    collection: 'course_enrollment_patterns',
    pageSize,
    schema: patternRow,
  }),
  course_equivalencies: await rows(request, {
    collection: 'course_equivalencies',
    pageSize,
    schema: equivalencyRow,
  }),
  courses: await rows(request, {
    collection: 'courses',
    pageSize,
    schema: courseRow,
  }),
  curriculum_2018: await rows(request, {
    collection: 'curriculum_2018',
    pageSize,
    schema: curriculum2018Row,
  }),
  curriculum_2023: await rows(request, {
    collection: 'curriculum_2023',
    pageSize,
    schema: curriculum2023Row,
  }),
  deans_office: await rows(request, {
    collection: 'deans_office',
    pageSize,
    schema: deansRow,
  }),
  discord_channels: await rows(request, {
    collection: 'discord_channels',
    pageSize,
    schema: discordRow,
  }),
  moodle_users: await rows(request, {
    collection: 'moodle_users',
    pageSize,
    schema: idRow,
  }),
  rooms: await rows(request, { collection: 'rooms', pageSize, schema: idRow }),
  staff: await rows(request, {
    collection: 'staff',
    pageSize,
    schema: staffRow,
  }),
  student_council: await rows(request, {
    collection: 'student_council',
    pageSize,
    schema: councilRow,
  }),
  students: await rows(request, {
    collection: 'students',
    pageSize,
    schema: studentRow,
  }),
  teaching_assignments: await rows(request, {
    collection: 'teaching_assignments',
    pageSize,
    schema: assignmentRow,
  }),
});

// The relational target collections, read for their provenance so a resumed
// migration reuses rows it already wrote. Before `npm run setup` ran their
// fields listing is refused, which reports the model as not installed; once
// a collection exists, any failure to read its rows (a missing provenance
// column, a token without read access) propagates instead of passing as
// "nothing written yet".
const readTargets = async (
  request: DirectusRequest,
  pageSize: number,
): Promise<null | TargetRows> => {
  for (const collection of targetCollections) {
    if ((await readColumnsOrNull(request, collection)) === null) {
      return null;
    }
  }
  return {
    academic_years: await rows(request, {
      collection: 'academic_years',
      pageSize,
      schema: academicYearRow,
    }),
    course_curricula: await rows(request, {
      collection: 'course_curricula',
      pageSize,
      schema: courseCurriculumRow,
    }),
    course_enrollment_rules: await rows(request, {
      collection: 'course_enrollment_rules',
      pageSize,
      schema: ruleRow,
    }),
    curriculum_entries: await rows(request, {
      collection: 'curriculum_entries',
      pageSize,
      schema: entryRow,
    }),
  };
};

// Reads everything the preflight inspects: the columns and rows of every
// checkpoint collection, every persisted Flow with its operations, and the
// provenance of the target rows.
export const readInventory = async (
  request: DirectusRequest,
  options: InventoryOptions,
): Promise<Inventory> => {
  const pageSize = options.pageSize ?? defaultPageSize;
  return {
    checkpoint: await readCheckpoint(request, pageSize),
    fields: await readCheckpointColumns(request),
    flows: await readAll(request, {
      fields: Object.keys(flowRow.shape),
      pageSize,
      pathname: '/flows',
      schema: flowRow,
    }),
    operations: await readAll(request, {
      fields: Object.keys(operationRow.shape),
      pageSize,
      pathname: '/operations',
      schema: operationRow,
    }),
    targets: await readTargets(request, pageSize),
  };
};
