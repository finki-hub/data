export const collectionKeys = [
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

export type CollectionKey = (typeof collectionKeys)[number];

export type CollectionSource =
  | {
      readonly endRow: number;
      readonly kind: 'discord-pairs';
      readonly sheet: string;
    }
  | {
      readonly headerRow?: number;
      readonly kind: 'rows';
      readonly sheet: string;
      readonly startRow?: number;
    }
  | {
      readonly kind: 'course-enrollment-patterns';
      readonly sheet: string;
    }
  | {
      readonly kind: 'student-pairs';
      readonly sheets: readonly string[];
    };

export type CollectionSpec = {
  readonly displayTemplate: string;
  readonly fields: readonly FieldSpec[];
  readonly icon: string;
  readonly key: CollectionKey;
  readonly note: string;
  readonly previewFields: readonly string[];
  readonly previewSort: string;
  readonly sort: number;
  readonly source: CollectionSource;
};

export type FieldKind = 'boolean' | 'integer' | 'string' | 'text';

export type FieldSpec = {
  readonly derived?: true;
  readonly fillDown?: true;
  readonly kind: FieldKind;
  readonly required?: true;
  readonly source?: string;
  readonly sourceColumn?: number;
  readonly sourceMode?: 'literal';
  readonly target: string;
};

export type MigrationData = Readonly<
  Record<CollectionKey, readonly MigrationItem[]>
>;

export type MigrationItem = Readonly<Record<string, Scalar>>;

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

export const derivedField = (
  target: string,
  kind: FieldKind = 'string',
): FieldSpec => ({ derived: true, kind, target });

export const schemaField = (
  target: string,
  kind: FieldKind = 'string',
): FieldSpec => ({ kind, target });

export const assertNever = (value: never): never => {
  throw new TypeError(`Unexpected collection source: ${String(value)}`);
};

export const relationalCollectionKeys = [
  'academic_years',
  'curriculum_entries',
  'course_curricula',
  'moodle_import_rows',
  'moodle_course_entries',
  'moodle_history_memberships',
  'moodle_course_mappings',
  'course_enrollment_rules',
  'course_enrollments',
  'data_operations',
  'data_operation_results',
  'migration_ledger',
] as const;

export type RelationalCollectionKey = (typeof relationalCollectionKeys)[number];

export type ModelCollectionKey = CollectionKey | RelationalCollectionKey;

export type ModelScalarKind = 'json' | 'timestamp' | FieldKind;

export type ModelFieldBase = {
  readonly field: string;
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

export type ModelEnumField = ModelFieldBase & {
  readonly choices: readonly string[];
  readonly defaultValue?: string;
  readonly kind: 'enum';
};

export type ModelRelationAlias = {
  readonly field: string;
  readonly fields: readonly string[];
  readonly readOnly?: true;
  readonly template: string;
};

export type ModelRelationField = ModelFieldBase & {
  readonly alias?: ModelRelationAlias;
  readonly kind: 'm2o';
  readonly onDelete: 'CASCADE' | 'SET NULL';
  readonly related: ModelCollectionKey;
  readonly sortField?: string;
  readonly template: string;
};

export type ModelField = ModelEnumField | ModelRelationField | ModelScalarField;

export type ModelCollection = {
  readonly collection: ModelCollectionKey;
  readonly displayTemplate: string;
  readonly fields: readonly ModelField[];
  readonly hidden: boolean;
  readonly icon: string;
  readonly note: string;
  readonly origin: 'checkpoint' | 'relational';
  readonly singleton: boolean;
  readonly sort: number;
};

export type ModelRelation = {
  readonly alias: ModelRelationAlias | null;
  readonly collection: ModelCollectionKey;
  readonly field: string;
  readonly nullable: boolean;
  readonly onDelete: 'CASCADE' | 'SET NULL';
  readonly related: ModelCollectionKey;
  readonly sortField: null | string;
};

export type CompositeKey = {
  readonly collection: ModelCollectionKey;
  readonly columns: readonly string[];
  readonly kind: 'index' | 'unique';
  readonly name: string;
};
