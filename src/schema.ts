// The parts of the workbook the one-time import reads, one per sheet (or
// pair of sheets). They name workbook content only: the import plans the
// relational rows from them (src/import/plan.ts), and none of them is
// a collection of its own except where the model declares one.
export const workbookKeys = [
  'courses',
  'staff',
  'rooms',
  'students',
  'curriculum_2023',
  'curriculum_2018',
  'course_equivalencies',
  'teaching_assignments',
  'course_enrollment_patterns',
  'discord_channels',
  'student_council',
  'deans_office',
  'moodle_users',
] as const;

export type WorkbookKey = (typeof workbookKeys)[number];

// A value per part of the workbook.
export const perWorkbookKey = <T>(
  value: (key: WorkbookKey) => T,
): Readonly<Record<WorkbookKey, T>> => ({
  course_enrollment_patterns: value('course_enrollment_patterns'),
  course_equivalencies: value('course_equivalencies'),
  courses: value('courses'),
  curriculum_2018: value('curriculum_2018'),
  curriculum_2023: value('curriculum_2023'),
  deans_office: value('deans_office'),
  discord_channels: value('discord_channels'),
  moodle_users: value('moodle_users'),
  rooms: value('rooms'),
  staff: value('staff'),
  student_council: value('student_council'),
  students: value('students'),
  teaching_assignments: value('teaching_assignments'),
});

export type CollectionSource =
  | {
      // The row holding the headers (1 unless set); the data starts below
      // it, and the rows above it (a title or totals) are not read.
      readonly headerRow?: number;
      readonly kind: 'rows';
      readonly sheet: string;
    }
  | {
      readonly kind: 'course-enrollment-patterns';
      readonly sheet: string;
    }
  | {
      readonly kind: 'generation-columns';
      readonly sheet: string;
    }
  | {
      readonly kind: 'student-pairs';
      readonly sheets: readonly string[];
    };

// How the import reads one part of the workbook: its sheet, and for every
// field its header (or fixed column), whether a formula cell reads as
// empty (`literal`), whether an empty cell repeats the value above it
// (`fillDown`), whether a cell a merged range covers reads as the range's
// top-left cell (`fillMerged`; for any other field it reads as empty),
// whether it must hold a value, and the kind its text is converted to.
export type WorkbookSpec = {
  readonly fields: readonly FieldSpec[];
  readonly key: WorkbookKey;
  readonly source: CollectionSource;
};

type FieldKind = 'boolean' | 'integer' | 'string' | 'text';

export type FieldSpec = {
  readonly fillDown?: true;
  readonly fillMerged?: true;
  // `id`: an integer that must be positive and unique within its column.
  readonly kind: 'id' | FieldKind;
  readonly required?: true;
  readonly source: string;
  readonly sourceColumn?: number;
  readonly sourceMode?: 'literal';
  readonly target: string;
};

export type WorkbookData = Readonly<
  Record<WorkbookKey, readonly WorkbookItem[]>
>;

export type WorkbookItem = Readonly<Record<string, Scalar>>;

// Where the import read a row: its sheet and row number, named in messages.
export type SheetRow = { readonly row: number; readonly sheet: string };

export type PlacedItem = {
  readonly item: WorkbookItem;
  readonly place: SheetRow;
};

export type Scalar = boolean | null | number | string;

export const field = (
  source: string,
  target: string,
  kind: FieldKind = 'string',
): FieldSpec => ({ kind, source, target });

export const requiredField = (
  source: string,
  target: string,
  kind: FieldKind = 'string',
): FieldSpec => ({ kind, required: true, source, target });

export const literalField = (
  source: string,
  target: string,
  kind: FieldKind = 'string',
): FieldSpec => ({ kind, source, sourceMode: 'literal', target });

export const assertNever = (value: never): never => {
  throw new TypeError(`Unexpected collection source: ${String(value)}`);
};

// Every collection of the Directus model; collections.ts orders them.
export type ModelCollectionKey =
  | 'academic_years'
  | 'anto_quotes'
  | 'bachelor_theses'
  | 'bachelor_thesis_staff'
  | 'course_accreditation_staff'
  | 'course_aliases'
  | 'course_curricula'
  | 'course_enrollments'
  | 'course_equivalencies'
  | 'course_equivalency_members'
  | 'course_teaching'
  | 'courses'
  | 'curriculum_entries'
  | 'curriculum_entry_program_states'
  | 'curriculum_generations'
  | 'data_operation_matches'
  | 'data_operations'
  | 'deans_office'
  | 'degree_programs'
  | 'discord_channel_courses'
  | 'discord_channels'
  | 'exam_sessions'
  | 'master_theses'
  | 'master_thesis_staff'
  | 'moodle_counted_lines'
  | 'moodle_course_entries'
  | 'moodle_course_mappings'
  | 'moodle_history_memberships'
  | 'moodle_import_rows'
  | 'moodle_pattern_mappings'
  | 'moodle_users'
  | 'room_aliases'
  | 'rooms'
  | 'staff'
  | 'staff_aliases'
  | 'student_council'
  | 'students'
  | 'study_programs'
  | 'teaching_assignments'
  | 'timetable_lessons'
  | 'timetable_slot_staff'
  | 'timetable_slots'
  | 'timetables';

// What an M2O field may point at: a collection of the model, or the
// Directus files (a file field, stored as the file's UUID).
export type RelatedCollection = 'directus_files' | ModelCollectionKey;

export type ModelScalarKind = 'json' | 'timestamp' | FieldKind;

type ModelFieldBase = {
  readonly field: string;
  readonly label?: string;
  readonly note?: string;
  readonly nullable: boolean;
  readonly readOnly?: true;
};

export type ModelScalarField = ModelFieldBase & {
  readonly defaultValue?: Scalar;
  readonly indexed?: true;
  readonly kind: ModelScalarKind;
  readonly minimum?: number;
  readonly unique?: true;
};

// One choice of a code-owned vocabulary: the stored value and the label
// Studio shows for it. Setup keeps both in step on an installed project.
export type EnumChoice = { readonly label: string; readonly value: string };

// `allowOther`: the choices are today's values, not a rule. The dropdown
// also takes a new value, stored and shown as typed, in a varchar(255)
// column with no server rule, so no stored value is ever outside the set.
export type ModelEnumField = ModelFieldBase & {
  readonly allowOther?: true;
  readonly choices: readonly EnumChoice[];
  readonly defaultValue?: string;
  readonly kind: 'enum';
};

// The reverse alias of an M2O relation on its "one" side. With `junction`
// the collection is a junction: the alias is a many-to-many that lists the
// rows its `junction` relation points at, each with its junction row.
export type ModelRelationAlias = {
  readonly field: string;
  readonly fields: readonly string[];
  readonly junction?: string;
  readonly label?: string;
  readonly note?: string;
  readonly readOnly?: true;
  readonly template: string;
};

// What a delete of the related row does to this row: delete it too, clear
// the link, or refuse the delete (NO ACTION: Directus 12.3.1 answers the
// foreign_key_violation with a 500 naming the constraint).
export type OnDelete = 'CASCADE' | 'NO ACTION' | 'SET NULL';

export type ModelRelationField = ModelFieldBase & {
  readonly alias?: ModelRelationAlias;
  readonly kind: 'm2o';
  readonly onDelete: OnDelete;
  readonly related: RelatedCollection;
  readonly sortField?: string;
  readonly template: string;
};

export type ModelField = ModelEnumField | ModelRelationField | ModelScalarField;

// A `label` is the English name Studio shows instead of the key. A
// collection's plural names the collection, its singular one row.
export type CollectionLabel = {
  readonly plural: string;
  readonly singular: string;
};

export type ModelCollection = {
  readonly collection: ModelCollectionKey;
  readonly displayTemplate: string;
  readonly fields: readonly ModelField[];
  readonly hidden: boolean;
  readonly icon: string;
  readonly label?: CollectionLabel;
  readonly note?: string;
  readonly singleton: boolean;
  readonly sort: number;
};
