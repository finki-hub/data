type GroupStart = 'closed' | 'open';

// A field group of a form: an alias field that hosts the listed members in
// the given order, under its English label.
export type FieldGroup = {
  readonly collection: string;
  readonly field: string;
  readonly headerIcon: string;
  readonly label: string;
  readonly members: readonly string[];
  readonly note?: string;
  readonly readOnly?: true;
  readonly sort: number;
  readonly start: GroupStart;
};

// A Studio form condition. Its rule must carry exactly one top-level key, or
// Studio silently ignores it. `clear_hidden_value_on_save` (Directus 12)
// saves a field the condition hides as null.
export type FieldCondition = {
  readonly clear_hidden_value_on_save?: boolean;
  readonly hidden?: boolean;
  readonly name: string;
  readonly readonly?: boolean;
  readonly required?: boolean;
  readonly rule: Readonly<Record<string, unknown>>;
};

// The Studio-only meta keys the presentation may set on a field. Nothing
// here changes a column or is enforced by the API.
type PresentationMeta = {
  readonly conditions?: readonly FieldCondition[];
  readonly display?: string;
  readonly display_options?: Readonly<Record<string, unknown>>;
  readonly group?: string;
  readonly hidden?: boolean;
  readonly note?: string;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly readonly?: boolean;
  readonly sort?: number;
  readonly width?: 'full' | 'half';
};

export type FieldPresentation = {
  readonly collection: string;
  readonly field: string;
  readonly meta: PresentationMeta;
};

// A sidebar folder: a `directus_collections` row without a table.
export type Folder = {
  readonly collapse: 'closed' | 'open';
  readonly collection: string;
  readonly icon: string;
  readonly label: string;
  readonly members: readonly string[];
  readonly note: string;
  readonly sort: number;
};

export type CollectionPlacement = {
  readonly collection: string;
  readonly meta: { readonly group: string; readonly sort: number };
};

type PresentationCounts = {
  readonly adopted: number;
  readonly created: number;
  readonly skipped: number;
};

export type PresentationSummary = {
  readonly collections: PresentationCounts;
  readonly fields: PresentationCounts;
  readonly groups: PresentationCounts;
  readonly presets: PresentationCounts;
};

type Outcome = keyof PresentationCounts;

export class PresentationTally {
  readonly #counts: Record<keyof PresentationSummary, Record<Outcome, number>> =
    {
      collections: { adopted: 0, created: 0, skipped: 0 },
      fields: { adopted: 0, created: 0, skipped: 0 },
      groups: { adopted: 0, created: 0, skipped: 0 },
      presets: { adopted: 0, created: 0, skipped: 0 },
    };

  public add(kind: keyof PresentationSummary, outcome: Outcome): void {
    this.#counts[kind][outcome] += 1;
  }

  public summary(): PresentationSummary {
    return structuredClone(this.#counts);
  }
}
