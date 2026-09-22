import type { Finding } from './report.js';
import type { SourceMapEntry } from './source-map.js';

export type TargetRecord = Readonly<Record<string, unknown>>;

// One write the applier performs: a row to create, or a patch of link
// columns on an existing row (then `record.id` names the row). `mappings`
// are the id-map entries the write establishes; a created row's target id
// is filled in once Directus returns it.
export type PlannedWrite<R extends TargetRecord> = {
  readonly mappings: readonly SourceMapEntry[];
  readonly record: R;
};

// What a converter returns: the writes still needed, the mappings that need
// none (a target row or link already present, or an unresolved relation
// retained for review) and the findings that explain every unresolved one.
// Converters are pure: they never touch the network and, given the same
// rows, return the same result in the same order.
export type Conversion<R extends TargetRecord> = {
  readonly findings: readonly Finding[];
  readonly settled: readonly SourceMapEntry[];
  readonly writes: ReadonlyArray<PlannedWrite<R>>;
};

// The findings and row counts the converter steps report back to the CLI,
// which prints aggregate counts only.
export type ConverterSink = {
  readonly findings: Finding[];
  readonly written: Record<string, number>;
};

export type ConverterOptions = {
  readonly batchSize: number;
  readonly sink: ConverterSink;
};

// Raised when a converter is handed an inconsistent state, such as a link
// whose target row the owning step has not created: a bug in the plan, not
// a condition to retry.
export class ConverterError extends Error {
  public override readonly name = 'ConverterError';
}

export const compositeKey = (
  ...parts: ReadonlyArray<number | string>
): string => parts.map(String).join('\u{0}');

export type Source = {
  readonly collection: string;
  readonly id: number | string;
  readonly relation: string;
};

const entry = (
  source: Source,
  targetCollection: string,
  target: Pick<SourceMapEntry, 'status' | 'targetId'>,
): SourceMapEntry => ({
  relation: source.relation,
  sourceCollection: source.collection,
  sourceId: source.id,
  status: target.status,
  targetCollection,
  targetId: target.targetId,
});

// A write still to perform; a link update already knows its target id.
export const pending = (
  source: Source,
  targetCollection: string,
  targetId: null | number = null,
): SourceMapEntry =>
  entry(source, targetCollection, { status: 'pending', targetId });

export const existing = (
  source: Source,
  targetCollection: string,
  targetId: number,
): SourceMapEntry =>
  entry(source, targetCollection, { status: 'existing', targetId });

export const unresolved = (
  source: Source,
  targetCollection: string,
): SourceMapEntry =>
  entry(source, targetCollection, { status: 'unresolved', targetId: null });

// Collects a conversion in the order the converter visits the rows.
export class Collector<R extends TargetRecord> {
  readonly #findings: Finding[] = [];
  readonly #settled: SourceMapEntry[] = [];
  readonly #writes: Array<PlannedWrite<R>> = [];

  public find(finding: Finding): void {
    this.#findings.push(finding);
  }

  public settle(...entries: readonly SourceMapEntry[]): void {
    this.#settled.push(...entries);
  }

  public write(record: R, mappings: readonly SourceMapEntry[]): void {
    this.#writes.push({ mappings, record });
  }

  public result(): Conversion<R> {
    return {
      findings: [...this.#findings],
      settled: [...this.#settled],
      writes: [...this.#writes],
    };
  }
}
