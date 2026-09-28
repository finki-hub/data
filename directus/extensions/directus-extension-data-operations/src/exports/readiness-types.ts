import type { Filter } from '@directus/types';

import type { Aggregate, ReadinessCheck } from './types.js';

// The shape of the readiness-check registry (readiness-registry.ts): every
// issue readiness can report, declared once in code. Readiness, its
// `issueCounts` keys, the Studio links, the Needs review bookmarks and the
// dashboard read these declarations; none of them is a Directus row, so no
// edit in Studio can turn a blocker into a warning.

export const severities = ['blocker', 'warning'] as const;

// The column that ties a record to its curriculum generation: a
// generation-scoped view shows it and filters through its relation.
export const generationField = 'generation';

// A bounded native aggregate over the entry's page collection: the rows
// the plain filter matches (`count`) or their distinct values of `field`
// (`countDistinct`). One count per assessment, never a record.
export type CountSource = {
  readonly aggregate: Aggregate;
  readonly field: string;
  readonly filter: Filter;
  readonly kind: 'count';
};

export type ReadinessEntry = {
  readonly code: string;
  // What the count means and how an editor resolves it.
  readonly description: string;
  // The public files a positive blocker holds back; a warning holds none.
  readonly gates: readonly string[];
  // Each record of the page carries a `generation` column: the review
  // view shows and filters by it (one view, never one per generation
  // row). Records keyed by per-generation columns are not scoped.
  readonly generationScoped: boolean;
  // The collection whose Studio page lists the records.
  readonly page: string;
  readonly review?: ReviewView;
  readonly severity: Severity;
  readonly source: ReadinessSource;
};

// Where an entry's count comes from: a native aggregate, a check that
// counts several codes in code from its own reads, the coordinator status
// (calculation domains) or the snapshot status (Task 10).
export type ReadinessSource =
  | CountSource
  | { readonly check: ReadinessCheck; readonly kind: 'check' }
  | { readonly kind: 'snapshot' }
  | { readonly kind: 'status' };

// The Studio view that lists the records behind an issue: a shared
// bookmark on the entry's page collection, created by setup when missing
// (one per entry, never one per generation row). Its filter uses plain
// field and relational paths only; Studio runs it as the viewer, so the
// viewer's permissions apply.
export type ReviewView = {
  readonly bookmark: string;
  readonly fields: readonly string[];
  readonly filter: Filter;
  // The bookmark icon; the collection's icon when absent.
  readonly icon?: string;
  readonly sort: readonly string[];
};

export type Severity = (typeof severities)[number];
