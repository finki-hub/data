import type {
  ModelCollection,
  ModelEnumField,
  ModelField,
  ModelRelation,
  ModelRelationAlias,
} from '../schema.js';
import type { ChoiceMeta } from './field-payloads.js';

export type Refusal = {
  readonly collection: string;
  readonly field: null | string;
  readonly reason: string;
};

export type CollectionAction = {
  readonly collection: ModelCollection;
  readonly kind: 'create-collection';
};

export type FieldAction =
  | {
      readonly alias: ModelRelationAlias;
      readonly collection: string;
      readonly kind: 'create-alias';
      readonly sort: number;
    }
  // An installed enum field whose choices or rule differ from the
  // declaration: the merged meta setup writes, once no live value falls
  // outside the declared choices.
  | {
      readonly collection: string;
      readonly field: ModelEnumField;
      readonly kind: 'realign-choices';
      readonly meta: ChoiceMeta;
      readonly singleton: boolean;
    }
  | {
      readonly collection: string;
      readonly field: ModelField;
      readonly kind: 'create-field';
      readonly sort: number;
    }
  // An installed column that lost the unique or index flag the model
  // declares (a Studio edit): the full alter payload that restores it.
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

// A collection is created, refused or skipped: setup takes over no
// existing one.
type CollectionCounts = {
  readonly created: number;
  readonly refused: number;
  readonly skipped: number;
};

// A field or relation can also be adopted: an installed one setup repairs
// in place (a field that lost its unique or index flag, a relation whose
// metadata diverges from the declaration).
type Counts = CollectionCounts & { readonly adopted: number };

// Fields also count the enum fields whose code-owned choices and rule were
// realigned.
type FieldCounts = Counts & { readonly aligned: number };

export type InstallSummary = {
  readonly collections: CollectionCounts;
  readonly fields: FieldCounts;
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

const zero = (): Record<Outcome, number> => ({
  adopted: 0,
  created: 0,
  refused: 0,
  skipped: 0,
});

export class Tally {
  #aligned = 0;
  readonly #collections: Record<keyof CollectionCounts, number> = {
    created: 0,
    refused: 0,
    skipped: 0,
  };
  readonly #counts: Record<'fields' | 'relations', Record<Outcome, number>> = {
    fields: zero(),
    relations: zero(),
  };

  public add(kind: 'fields' | 'relations', outcome: Outcome, amount = 1): void {
    this.#counts[kind][outcome] += amount;
  }

  public addCollection(outcome: keyof CollectionCounts): void {
    this.#collections[outcome] += 1;
  }

  public align(): void {
    this.#aligned += 1;
  }

  public summary(): InstallSummary {
    const counts = structuredClone(this.#counts);
    return {
      collections: { ...this.#collections },
      fields: { ...counts.fields, aligned: this.#aligned },
      relations: counts.relations,
    };
  }
}
