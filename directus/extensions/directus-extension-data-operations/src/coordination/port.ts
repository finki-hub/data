import type { EnrollmentSources, RuleMode } from '../enrollment-pages.js';
import type { CountRow, PageRange } from '../page-state.js';
import type { ClaimDomain, Domain } from './domains.js';
import type { Fingerprints } from './fingerprint.js';
import type { HistoryIndexPort } from './history-port.js';
import type { StoredOutcomes } from './outcomes.js';
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
  // Guard: claim token and owner. Makes the claim's revision the current
  // source revision. Sound only under the singleton lock, right after a
  // statement of this run on a source table: nothing else can have moved
  // the revision in between, and the run's own rows cannot change its
  // output.
  readonly adoptOwnRevision: (token: string, owner: string) => Promise<boolean>;
  readonly candidateCount: (token: string) => Promise<number>;
  // The fingerprints of the calculation and the publication graph.
  readonly currentFingerprints: () => Promise<Fingerprints>;
  readonly discardCandidates: (token: string, page?: string) => Promise<number>;
  // The id, mode and pattern bytes of every enrollment rule and the id
  // and Courses bytes of every Moodle user: what an enrollments plan is
  // cut from. No pattern, course, year or history text is read.
  readonly enrollmentSources: () => Promise<EnrollmentSources>;
  readonly ensureSingleton: () => Promise<void>;
  // Guard: claim token, owner, claim revision, the claimed domain's inputs
  // (verifyClaim, waived for a superseded publication) and fingerprint
  // unchanged.
  readonly finish: (input: FinishInput) => Promise<boolean>;
  // Guard: claim token and owner. Dates the heartbeat leaseMs after now
  // (none by default), so the claim counts as alive until then.
  readonly heartbeat: (
    token: string,
    owner: string,
    leaseMs?: number,
  ) => Promise<boolean>;
  // The history index writes of the same transaction.
  readonly history: HistoryIndexPort;
  readonly insertCandidates: (input: StagedRows) => Promise<number>;
  // Replaces every course_enrollments row with the aggregated candidates
  // of the claim and returns how many rows were installed.
  readonly installEnrollments: (
    token: string,
    revision: number,
  ) => Promise<number>;
  // Bounds how long the rest of this transaction waits for a row lock; a
  // longer wait fails with SQLSTATE 55P03 (lock_not_available).
  readonly limitLockWait: (ms: number) => Promise<void>;
  // Moves the source revision, the input revision of every calculation
  // the marked domains touch, and adds them to the dirty domains.
  readonly markDomains: (domains: readonly Domain[]) => Promise<MarkResult>;
  // With lock, the singleton row is locked until the transaction ends;
  // every transaction that writes reads it locked before anything else.
  readonly readState: (lock: boolean) => Promise<OperationsState>;
  // Guard: claim token, owner and a publication claim. Replaces the
  // publication outcomes with the map given (the recorded one plus a file)
  // and refreshes the heartbeat, which ends an upload lease.
  readonly recordOutcomes: (
    token: string,
    owner: string,
    files: StoredOutcomes,
  ) => Promise<boolean>;
  // Guard: claim token, owner and the claimed domain's inputs unchanged.
  // Appends the page to the staged list atomically and refreshes the
  // heartbeat.
  readonly recordStagedPage: (
    token: string,
    owner: string,
    page: string,
  ) => Promise<boolean>;
  // Guard: claim token. Clears the claim and records the failure details;
  // a publication's state follows releasedPublicationState over the map
  // given, or else the recorded one.
  readonly release: (input: ReleaseInput) => Promise<boolean>;
  // The id, mode and pattern bytes of every enrollment rule (never its
  // pattern), for a rules plan's check that no rule is legacy_regex.
  readonly ruleModes: () => Promise<readonly RuleMode[]>;
  readonly sourceIds: (source: PageSource) => Promise<readonly number[]>;
  // Guard: claim token, owner and the claimed domain's inputs unchanged. A
  // page of an enrollments plan carries its kind (and a legacy page its bytes and rule
  // range) beside the range the coordinator keeps.
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

export type FinishInput = {
  readonly claimRevision: number;
  readonly dirtyDomains: readonly Domain[];
  // Per-file publication outcomes keyed by the published filename; they
  // replace the previous outcomes whole. Null for a calculation.
  readonly files: null | StoredOutcomes;
  readonly fingerprint: string;
  readonly owner: string;
  // A publication whose every file was uploaded from its claimed revision
  // while a later source change committed: it is recorded at that revision
  // and the caller keeps publication pending for the newer one.
  readonly superseded: boolean;
  readonly token: string;
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
  // The outcome of each file a publication attempted before it was
  // released; absent or null keeps the recorded outcomes.
  readonly files?: null | StoredOutcomes;
  // Why, as the status shows it (bounded, ids and counts only); absent or
  // null when the release names no cause (a snapshot promotion's claim,
  // whose failure the promotion records itself).
  readonly message?: null | string;
  readonly token: string;
};

export type StagedRows = {
  readonly page: string;
  readonly revision: number;
  readonly rows: readonly CountRow[];
  readonly token: string;
};
