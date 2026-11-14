import type {
  EnumChoice,
  ModelEnumField,
  ModelField,
  ModelRelationField,
  ModelScalarField,
  ModelScalarKind,
  RelatedCollection,
} from '../schema.js';

type ScalarOptions = Partial<Omit<ModelScalarField, 'field' | 'kind'>>;
type EnumOptions = Partial<Omit<ModelEnumField, 'choices' | 'field' | 'kind'>>;
type RelationOptions = Partial<
  Omit<ModelRelationField, 'field' | 'kind' | 'related'>
>;

// A declaration that keeps its key as a literal type, so a record keyed by
// the fields of a collection is checked against them (labelledFields).
type Keyed<Field extends ModelField, Key extends string> = Field & {
  readonly field: Key;
};

export const scalar = <Key extends string>(
  field: Key,
  kind: ModelScalarKind,
  options: ScalarOptions = {},
): Keyed<ModelScalarField, Key> => ({
  field,
  kind,
  nullable: true,
  ...options,
});

// A column that must hold a value.
export const required = <Key extends string>(
  field: Key,
  kind: ModelScalarKind = 'string',
  options: ScalarOptions = {},
): Keyed<ModelScalarField, Key> =>
  scalar(field, kind, { ...options, nullable: false });

// The choices of a vocabulary, in the order of its values, each with the
// one label the record declares for it (a missing or extra label does not
// compile).
export const labelledChoices = <const V extends string>(
  values: readonly V[],
  labels: Readonly<Record<V, string>>,
): readonly EnumChoice[] =>
  values.map((value) => ({ label: labels[value], value }));

export const enumField = <Key extends string>(
  field: Key,
  choices: readonly EnumChoice[],
  options: EnumOptions = {},
): Keyed<ModelEnumField, Key> => ({
  choices,
  field,
  kind: 'enum',
  nullable: true,
  ...options,
});

// The fields, each with the label the record declares for its key (a
// missing label does not compile).
export const labelledFields = <Key extends string>(
  fields: ReadonlyArray<Keyed<ModelField, Key>>,
  labels: Readonly<Record<NoInfer<Key>, string>>,
): readonly ModelField[] =>
  fields.map((field) => ({ ...field, label: labels[field.field] }));

// The stored values an enum field accepts, in declaration order.
export const choiceValues = (field: ModelEnumField): string[] =>
  field.choices.map(({ value }) => value);

export const m2o = (
  field: string,
  related: RelatedCollection,
  options: RelationOptions = {},
): ModelRelationField => ({
  field,
  kind: 'm2o',
  nullable: true,
  onDelete: options.nullable === false ? 'CASCADE' : 'SET NULL',
  related,
  template: '{{id}}',
  ...options,
});

// A file field: an M2O onto the Directus files, edited with the file
// interface.
export const isFileField = (field: ModelRelationField): boolean =>
  field.related === 'directus_files';

// The Directus column type an existing column must report to be compatible.
export const expectedColumnType = (field: ModelField): string => {
  if (field.kind === 'enum') {
    return 'string';
  }
  if (field.kind === 'm2o') {
    return isFileField(field) ? 'uuid' : 'integer';
  }
  return field.kind;
};
