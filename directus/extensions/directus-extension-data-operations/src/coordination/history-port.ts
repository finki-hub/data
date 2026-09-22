import type { MembershipRow } from '../history-contract.js';

export type HistoryEntryRef = {
  readonly id: number;
  readonly label: string;
};

// The history index writes, inside the coordinator's transaction. Entries
// are only ever created (as needs_mapping) and looked up; a label that
// exists keeps its review state, reason and mappings whatever the page
// says. Memberships are the replaceable index: deleted per user and
// re-inserted as unique pairs.
export type HistoryIndexPort = {
  // One INSERT statement for the given labels; every one of them must be
  // missing, the statement-level source trigger fires once regardless.
  readonly createEntries: (labels: readonly string[]) => Promise<number>;
  readonly deleteMemberships: (users: readonly number[]) => Promise<number>;
  readonly entriesByLabel: (
    labels: readonly string[],
  ) => Promise<readonly HistoryEntryRef[]>;
  readonly insertMemberships: (
    rows: readonly MembershipRow[],
  ) => Promise<number>;
  // Admits this transaction past the membership write guard of the
  // schema-constraints migration; every other writer is refused there.
  readonly openWriter: () => Promise<void>;
  readonly summary: () => Promise<HistorySummary>;
  // The Moodle user ids inside an inclusive id range, ascending.
  readonly userIdsBetween: (
    from: number,
    to: number,
  ) => Promise<readonly number[]>;
};

// The bounded comparison of the derived index with the raw snapshot: how
// many users carry memberships, how many entries still need a mapping and
// how many users' distinct indexed entries differ from the scraper's own
// `Courses Count`. Aggregates only, never a profile.
export type HistorySummary = {
  readonly countMismatches: number;
  readonly entries: number;
  readonly indexedUsers: number;
  readonly memberships: number;
  readonly needsMapping: number;
  readonly users: number;
};
