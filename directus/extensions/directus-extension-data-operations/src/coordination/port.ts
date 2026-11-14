import type { MatchRow, PageRange } from '../page-state.js';
import type { ClaimDomain, Domain } from './domains.js';
import type { Fingerprints } from './fingerprint.js';
import type { HistoryIndexPort } from './history-port.js';
import type { OperationsState, PageSource } from './state.js';

export type ClaimInsert = {
  readonly dirtyDomains: readonly Domain[];
  readonly domain: ClaimDomain;
  readonly fingerprint: string;
  readonly owner: string;
  readonly sourceRevision: number;
  readonly token: string;
};

// Everything the coordinator needs from storage, inside one transaction.
// Every writer returns whether its guard matched: a false means the claim
// is no longer the one the caller holds, and the caller must not proceed.
export type CoordinationPort = {
  // Guard: claim token and owner. Adds the retries of a transaction that
  // ran again after a database conflict to the claim's count.
  readonly addRetries: (
    token: string,
    owner: string,
    retries: number,
  ) => Promise<boolean>;
  // Guard: claim token and owner. Makes the claim's revision the current
  // source revision. Sound only under the singleton lock, right after a
  // statement of this run on a source table: nothing else can have moved
  // the revision in between, and the run's own rows cannot change its
  // output.
  readonly adoptOwnRevision: (token: string, owner: string) => Promise<boolean>;
  readonly candidateCount: (token: string) => Promise<number>;
  // The fingerprint of the calculation graph.
  readonly currentFingerprints: () => Promise<Fingerprints>;
  readonly discardCandidates: (token: string, page?: string) => Promise<number>;
  readonly ensureSingleton: () => Promise<void>;
  // Guard: claim token, owner, claim revision, the claimed domain's inputs
  // (verifyClaim) and fingerprint unchanged.
  readonly finish: (input: FinishInput) => Promise<boolean>;
  // Guard: claim token and owner.
  readonly heartbeat: (token: string, owner: string) => Promise<boolean>;
  // The history index writes of the same transaction.
  readonly history: HistoryIndexPort;
  readonly insertCandidates: (input: StagedRows) => Promise<number>;
  // Rebuilds moodle_counted_lines from the explicit mappings and the
  // matches the claim staged, then every course_enrollments row, one per
  // course and academic year, and returns how many rows each received.
  readonly installEnrollments: (
    token: string,
    revision: number,
  ) => Promise<InstalledCounts>;
  // Bounds how long the rest of this transaction waits for a row lock; a
  // longer wait fails with SQLSTATE 55P03 (lock_not_available).
  readonly limitLockWait: (ms: number) => Promise<void>;
  // Moves the source revision, the input revision of every calculation
  // the marked domains touch, and adds them to the dirty domains.
  readonly markDomains: (domains: readonly Domain[]) => Promise<MarkResult>;
  // With lock, the singleton row is locked until the transaction ends;
  // every transaction that writes reads it locked before anything else.
  readonly readState: (lock: boolean) => Promise<OperationsState>;
  // Guard: claim token, owner and the claimed domain's inputs unchanged.
  // Appends the page to the staged list atomically and refreshes the
  // heartbeat.
  readonly recordStagedPage: (
    token: string,
    owner: string,
    page: string,
  ) => Promise<boolean>;
  // Guard: claim token. Clears the claim and records the failure details.
  readonly release: (input: ReleaseInput) => Promise<boolean>;
  readonly sourceIds: (source: PageSource) => Promise<readonly number[]>;
  // Guard: claim token, owner and the claimed domain's inputs unchanged.
  readonly storePlan: (
    token: string,
    owner: string,
    pages: readonly PageRange[],
  ) => Promise<boolean>;
  // Guard: no claim present and the source revision as read.
  readonly takeClaim: (input: ClaimInsert) => Promise<boolean>;
};

export type CoordinationStore = {
  readonly transaction: <T>(
    work: (port: CoordinationPort) => Promise<T>,
  ) => Promise<T>;
};

// What an enrollments completion installed: the counted lines and the
// count rows.
export type InstalledCounts = {
  readonly counted: number;
  readonly installed: number;
};

export type MarkResult = {
  readonly dirtyDomains: readonly Domain[];
  readonly sourceRevision: number;
};

export type ReleaseInput = {
  readonly code: string;
  // True for a genuine failure (fail, abandoned); false when the run was
  // merely overtaken by a source or graph change and will simply rerun.
  readonly failed: boolean;
  // Why, as the status shows it (bounded, ids and counts only); absent or
  // null when the release names no cause (a snapshot promotion's claim,
  // whose failure the promotion records itself).
  readonly message?: null | string;
  readonly token: string;
};

export type StagedRows = {
  readonly page: string;
  readonly rows: readonly MatchRow[];
  readonly token: string;
};

type FinishInput = {
  readonly claimRevision: number;
  readonly dirtyDomains: readonly Domain[];
  readonly fingerprint: string;
  readonly owner: string;
  readonly token: string;
};
