import type {
  ModelCollection,
  ModelField,
  ModelRelation,
  ModelRelationAlias,
} from '../schema.js';

export type Refusal = {
  readonly collection: string;
  readonly field: null | string;
  readonly reason: string;
};

export type CollectionAction = {
  readonly collection: ModelCollection;
  readonly kind: 'adopt-collection' | 'create-collection';
};

export type FieldAction =
  | {
      readonly alias: ModelRelationAlias;
      readonly collection: string;
      readonly kind: 'create-alias';
      readonly sort: number;
    }
  | {
      readonly collection: string;
      readonly field: ModelField;
      readonly kind: 'adopt-meta';
      readonly sort: number;
    }
  | {
      readonly collection: string;
      readonly field: ModelField;
      readonly kind: 'create-field';
      readonly sort: number;
    }
  | {
      readonly collection: string;
      readonly field: string;
      readonly kind: 'add-flags';
      readonly schema: Readonly<Record<string, unknown>>;
    };

export type RelationAction = {
  readonly kind: 'align-relation' | 'create-relation';
  readonly relation: ModelRelation;
};

export type Counts = {
  readonly adopted: number;
  readonly created: number;
  readonly refused: number;
  readonly skipped: number;
};

export type InstallSummary = {
  readonly collections: Counts;
  readonly fields: Counts;
  readonly relations: Counts;
};

export type InstallPlan = {
  readonly collections: readonly CollectionAction[];
  readonly fields: readonly FieldAction[];
  readonly refusals: readonly Refusal[];
  readonly relations: readonly RelationAction[];
  readonly summary: InstallSummary;
};

type Outcome = keyof Counts;

export class Tally {
  readonly #counts: Record<keyof InstallSummary, Record<Outcome, number>> = {
    collections: { adopted: 0, created: 0, refused: 0, skipped: 0 },
    fields: { adopted: 0, created: 0, refused: 0, skipped: 0 },
    relations: { adopted: 0, created: 0, refused: 0, skipped: 0 },
  };

  public add(kind: keyof InstallSummary, outcome: Outcome, amount = 1): void {
    this.#counts[kind][outcome] += amount;
  }

  public summary(): InstallSummary {
    return structuredClone(this.#counts);
  }
}
