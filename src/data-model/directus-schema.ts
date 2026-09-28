import { z } from 'zod';

// Response items of `GET /collections`; a null `schema` marks a folder.
export const existingCollectionsSchema = z.array(
  z.object({
    collection: z.string(),
    meta: z.unknown().nullable(),
    schema: z.unknown().nullable(),
  }),
);

export type ExistingCollection = z.infer<
  typeof existingCollectionsSchema
>[number];

const columnSchema = z.looseObject({
  default_value: z.unknown().optional(),
  foreign_key_table: z.string().nullable().optional(),
  is_indexed: z.boolean(),
  is_nullable: z.boolean(),
  is_primary_key: z.boolean(),
  is_unique: z.boolean(),
  max_length: z.number().nullable().optional(),
  numeric_precision: z.number().nullable().optional(),
  numeric_scale: z.number().nullable().optional(),
});

type ExistingColumn = z.infer<typeof columnSchema>;

// Response items of `GET /fields/:collection`. Aliases carry a null schema.
export const existingFieldsSchema = z.array(
  z.object({
    field: z.string(),
    meta: z
      .looseObject({ special: z.array(z.string()).nullable().optional() })
      .nullable(),
    schema: columnSchema.nullable(),
    type: z.string().nullable(),
  }),
);

export type ExistingField = z.infer<typeof existingFieldsSchema>[number];

// Response items of `GET /relations/:collection` (many side only). A null
// `schema` marks a meta-only relation whose foreign key is missing.
export const existingRelationsSchema = z.array(
  z.object({
    collection: z.string(),
    field: z.string(),
    meta: z
      .looseObject({
        junction_field: z.string().nullable().optional(),
        one_deselect_action: z.string().nullable().optional(),
        one_field: z.string().nullable().optional(),
        sort_field: z.string().nullable().optional(),
      })
      .nullable(),
    related_collection: z.string().nullable(),
    schema: z
      .looseObject({ on_delete: z.string().nullable().optional() })
      .nullable()
      .optional(),
  }),
);

export type ExistingRelation = z.infer<typeof existingRelationsSchema>[number];

export type ExistingState = {
  readonly collections: ReadonlyMap<string, ExistingCollection>;
  readonly fields: ReadonlyMap<string, readonly ExistingField[]>;
  readonly relations: ReadonlyMap<string, readonly ExistingRelation[]>;
};

// The column properties Directus re-applies on every schema alter.
export const alterableColumn = (column: ExistingColumn) => ({
  default_value: column.default_value ?? null,
  is_indexed: column.is_indexed,
  is_nullable: column.is_nullable,
  is_unique: column.is_unique,
  max_length: column.max_length ?? null,
  numeric_precision: column.numeric_precision ?? null,
  numeric_scale: column.numeric_scale ?? null,
});
