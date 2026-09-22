import type {
  FieldSpec,
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

export const enumField = (
  field: string,
  choices: readonly string[],
  options: EnumOptions = {},
): ModelEnumField => ({
  choices,
  field,
  kind: 'enum',
  nullable: true,
  ...options,
});

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

export const fromCheckpointField = (spec: FieldSpec): ModelScalarField => ({
  field: spec.target,
  kind: spec.kind,
  nullable: spec.required !== true,
  ...(spec.derived === true && { readOnly: true }),
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
