import type {
  ModelEnumField,
  ModelField,
  ModelRelationAlias,
  ModelRelationField,
  ModelScalarField,
  ModelScalarKind,
  Scalar,
} from '../schema.js';

import { type FieldTranslation, fieldTranslations } from './translations.js';

type FieldSchemaPayload = {
  readonly default_value?: Scalar;
  readonly is_indexed?: true;
  readonly is_nullable: boolean;
  readonly is_unique?: true;
  readonly max_length?: number;
};

type FieldMetaPayload = {
  readonly display?: string;
  readonly display_options?: Readonly<Record<string, unknown>>;
  readonly interface: string;
  readonly note?: string;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly readonly: boolean;
  readonly required: boolean;
  readonly sort: number;
  readonly special?: readonly string[];
  readonly translations?: readonly FieldTranslation[];
  readonly validation?: Readonly<Record<string, unknown>>;
  readonly width: 'full' | 'half';
};

type FieldPayload = {
  readonly field: string;
  readonly meta: FieldMetaPayload;
  readonly schema?: FieldSchemaPayload;
  readonly type: string;
};

export const enumMaxLength = 64;

const interfaces: Readonly<Record<ModelScalarKind, string>> = {
  boolean: 'boolean',
  integer: 'input',
  json: 'input-code',
  string: 'input',
  text: 'input-multiline',
  timestamp: 'datetime',
};

const displays: Readonly<Partial<Record<ModelScalarKind, string>>> = {
  boolean: 'boolean',
  json: 'raw',
  timestamp: 'datetime',
};

// A server-enforced rule that also admits null when the field is nullable.
const validationRule = (
  field: ModelField,
  rule: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const membership = { [field.field]: rule };
  return field.nullable
    ? { _or: [{ [field.field]: { _null: true } }, membership] }
    : membership;
};

// The code-owned part of an enum field's meta: its choices, as the dropdown
// offers them and as the labels display shows them, and the server-enforced
// membership rule. Setup writes exactly these keys when it realigns an
// installed field; every other meta key (note, width, group, sort,
// conditions, placeholder) belongs to Studio.
export type ChoiceMeta = {
  readonly display_options: Readonly<Record<string, unknown>>;
  readonly options: Readonly<Record<string, unknown>>;
  readonly validation: Readonly<Record<string, unknown>>;
};

export const enumChoiceMeta = (field: ModelEnumField): ChoiceMeta => {
  const choices = field.choices.map(({ label, value }) => ({
    text: label,
    value,
  }));
  return {
    display_options: { choices },
    options: { allowNone: field.nullable, allowOther: false, choices },
    validation: validationRule(field, {
      _in: field.choices.map(({ value }) => value),
    }),
  };
};

// The English label of a field or alias, only when one is declared.
const labelMeta = (
  label: string | undefined,
): Pick<FieldMetaPayload, 'translations'> =>
  label === undefined ? {} : { translations: fieldTranslations(label) };

const baseMeta = (
  field: ModelField,
  sort: number,
  width: 'full' | 'half',
): Pick<
  FieldMetaPayload,
  'note' | 'readonly' | 'required' | 'sort' | 'translations' | 'width'
> => ({
  ...(field.note !== undefined && { note: field.note }),
  readonly: field.readOnly === true,
  required: !field.nullable,
  sort,
  ...labelMeta(field.label),
  width,
});

const scalarPayload = (field: ModelScalarField, sort: number): FieldPayload => {
  const display = displays[field.kind];
  return {
    field: field.field,
    meta: {
      ...baseMeta(field, sort, field.kind === 'text' ? 'full' : 'half'),
      ...(display !== undefined && { display }),
      interface: interfaces[field.kind],
      ...(field.kind === 'json' && { options: { language: 'json' } }),
      ...(field.minimum !== undefined && {
        validation: validationRule(field, { _gte: field.minimum }),
      }),
    },
    schema: {
      ...(field.defaultValue !== undefined && {
        default_value: field.defaultValue,
      }),
      ...(field.indexed === true && { is_indexed: true }),
      is_nullable: field.nullable,
      ...(field.unique === true && { is_unique: true }),
    },
    type: field.kind,
  };
};

const enumPayload = (field: ModelEnumField, sort: number): FieldPayload => ({
  field: field.field,
  meta: {
    ...baseMeta(field, sort, 'half'),
    ...enumChoiceMeta(field),
    display: 'labels',
    interface: 'select-dropdown',
  },
  schema: {
    ...(field.defaultValue !== undefined && {
      default_value: field.defaultValue,
    }),
    is_nullable: field.nullable,
    max_length: enumMaxLength,
  },
  type: 'string',
});

const relationPayload = (
  field: ModelRelationField,
  sort: number,
): FieldPayload => ({
  field: field.field,
  meta: {
    ...baseMeta(field, sort, 'half'),
    display: 'related-values',
    display_options: { template: field.template },
    interface: 'select-dropdown-m2o',
    options: {
      enableCreate: false,
      enableLink: true,
      enableSelect: true,
      template: field.template,
    },
    special: ['m2o'],
  },
  schema: { is_indexed: true, is_nullable: field.nullable },
  type: 'integer',
});

export const toFieldPayload = (
  field: ModelField,
  sort: number,
): FieldPayload => {
  if (field.kind === 'enum') {
    return enumPayload(field, sort);
  }
  if (field.kind === 'm2o') {
    return relationPayload(field, sort);
  }
  return scalarPayload(field, sort);
};

// The special an alias carries: `m2m` through a junction, else `o2m`.
export const aliasSpecial = (alias: ModelRelationAlias): 'm2m' | 'o2m' =>
  alias.junction === undefined ? 'o2m' : 'm2m';

// The reverse alias: an O2M list, or through a junction an M2M list whose
// junction rows carry their own values (`fields` and `template` address
// the junction row) and whose rows are picked from the related collection,
// never created from it. Aliases onto derived collections are read-only
// so Studio cannot create, link or reorder rows only the Flows may write.
export const toAliasPayload = (
  alias: ModelRelationAlias,
  sort: number,
): FieldPayload => {
  const editable = alias.readOnly !== true;
  const special = aliasSpecial(alias);
  return {
    field: alias.field,
    meta: {
      display: 'related-values',
      display_options: { template: alias.template },
      interface: special === 'm2m' ? 'list-m2m' : 'list-o2m',
      options: {
        enableCreate: special === 'o2m' && editable,
        enableLink: true,
        enableSelect: editable,
        fields: alias.fields,
        ...(special === 'm2m' && { junctionFieldLocation: 'top' }),
        layout: 'table',
        template: alias.template,
      },
      ...(alias.note !== undefined && { note: alias.note }),
      readonly: !editable,
      required: false,
      sort,
      special: [special],
      ...labelMeta(alias.label),
      width: 'full',
    },
    type: 'alias',
  };
};
