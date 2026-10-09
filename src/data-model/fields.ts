import type {
  EnumChoice,
  ModelCollectionKey,
  ModelEnumField,
  ModelField,
  ModelRelationField,
  ModelScalarField,
  ModelScalarKind,
} from '../schema.js';

type ScalarOptions = Partial<Omit<ModelScalarField, 'field' | 'kind'>>;
type EnumOptions = Partial<Omit<ModelEnumField, 'choices' | 'field' | 'kind'>>;
type RelationOptions = Partial<
  Omit<ModelRelationField, 'field' | 'kind' | 'related'>
>;

export const scalar = (
  field: string,
  kind: ModelScalarKind,
  options: ScalarOptions = {},
): ModelScalarField => ({ field, kind, nullable: true, ...options });

// A column that must hold a value.
export const required = (
  field: string,
  kind: ModelScalarKind = 'string',
): ModelScalarField => scalar(field, kind, { nullable: false });

// The choices of a vocabulary, in the order of its values, each with the
// one label the record declares for it (a missing or extra label does not
// compile).
export const labelledChoices = <const V extends string>(
  values: readonly V[],
  labels: Readonly<Record<V, string>>,
): readonly EnumChoice[] =>
  values.map((value) => ({ label: labels[value], value }));

export const enumField = (
  field: string,
  choices: readonly EnumChoice[],
  options: EnumOptions = {},
): ModelEnumField => ({
  choices,
  field,
  kind: 'enum',
  nullable: true,
  ...options,
});

// The stored values an enum field accepts, in declaration order.
export const choiceValues = (field: ModelEnumField): string[] =>
  field.choices.map(({ value }) => value);

export const m2o = (
  field: string,
  related: ModelCollectionKey,
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

// The Directus column type an existing column must report to be compatible.
export const expectedColumnType = (field: ModelField): string => {
  if (field.kind === 'enum') {
    return 'string';
  }
  if (field.kind === 'm2o') {
    return 'integer';
  }
  return field.kind;
};
