import type {
  ModelCollectionKey,
  ModelRelationAlias,
  OnDelete,
  RelatedCollection,
} from './schema.js';

// The relations and composite keys of the Directus model, derived from the
// M2O fields (src/data-model/relations.ts) or declared beside them.

export type ModelRelation = {
  readonly alias: ModelRelationAlias | null;
  readonly collection: ModelCollectionKey;
  readonly field: string;
  // The other relation of a junction collection, or null.
  readonly junction: null | string;
  readonly nullable: boolean;
  readonly onDelete: OnDelete;
  readonly related: RelatedCollection;
  readonly sortField: null | string;
};

// `nullsNotDistinct`: two rows with NULL in the same key columns collide.
export type CompositeKey = {
  readonly collection: ModelCollectionKey;
  readonly columns: readonly string[];
  readonly kind: 'index' | 'unique';
  readonly name: string;
  readonly nullsNotDistinct?: true;
};
