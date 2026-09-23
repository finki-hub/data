import type { IssueCounts } from './types.js';

// The readiness facts that come from the coordinator and the snapshot
// status rather than from a read: the counts of the registry entries whose
// source is `status` or `snapshot` (readiness-registry.ts).

export const calculationDomains = ['history_index', 'enrollments'] as const;

// The states of a calculation domain that is not current; each is one
// blocker code `<domain>_<state>`.
export const notCurrentStates = ['pending', 'running', 'failed'] as const;

// The coordinator facts readiness reads: the source revision, the
// fingerprint of the last accepted calculation and the state of each
// calculation domain (current, pending, running or failed).
export type CoordinationFacts = {
  readonly calculation: null | string;
  readonly domains: Readonly<Record<string, string>>;
  readonly revision: number;
};

// Task 10's snapshot facts: the import state and whether the active
// Moodle users still equal the last promoted snapshot (null before the
// first promotion).
export type SnapshotFacts = {
  readonly activeMatchesPromotion: boolean | null;
  readonly activeRows: number;
  readonly state: string;
};

// A calculation that is not current counts once under
// `<domain>_<state>`; a state readiness has no code for is refused by the
// caller, never ignored.
export const statusCounts = (facts: CoordinationFacts): IssueCounts =>
  Object.fromEntries(
    calculationDomains.flatMap((domain) => {
      const state = facts.domains[domain];
      return state === 'current' ? [] : [[`${domain}_${String(state)}`, 1]];
    }),
  );

const importing: ReadonlySet<string> = new Set([
  'importing',
  'promoting',
  'validating',
]);

// An import in flight or failed, a staged snapshot not promoted, active
// users edited outside the snapshot workflow and a project whose users
// never came through a promotion.
export const snapshotCounts = (facts: SnapshotFacts): IssueCounts => ({
  active_snapshot_edited: Number(facts.activeMatchesPromotion === false),
  snapshot_import_failed: Number(facts.state === 'failed'),
  snapshot_import_running: Number(importing.has(facts.state)),
  snapshot_never_promoted: Number(
    facts.activeMatchesPromotion === null && facts.activeRows > 0,
  ),
  snapshot_staged: Number(facts.state === 'ready'),
});
