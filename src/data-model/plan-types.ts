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
      readonly field: ModelEnumField;
      readonly kind: 'realign-choices';
      readonly meta: ChoiceMeta;
      readonly singleton: boolean;
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
  // An installed enum field whose choices or rule differ from the
  // declaration: the merged meta setup writes, once no live value falls
  // outside the declared choices.
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

// Fields also count the enum fields whose code-owned choices and rule were
// realigned.
export type FieldCounts = Counts & { readonly aligned: number };

export type InstallSummary = {
  readonly collections: Counts;
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
  readonly #counts: Record<keyof InstallSummary, Record<Outcome, number>> = {
    collections: zero(),
    fields: zero(),
    relations: zero(),
  };

  public add(kind: keyof InstallSummary, outcome: Outcome, amount = 1): void {
    this.#counts[kind][outcome] += amount;
  }

  public align(): void {
    this.#aligned += 1;
  }

  public summary(): InstallSummary {
    const counts = structuredClone(this.#counts);
    return { ...counts, fields: { ...counts.fields, aligned: this.#aligned } };
  }
}
